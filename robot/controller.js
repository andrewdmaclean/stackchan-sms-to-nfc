// Platform-neutral event flow; the MOD injects the community camera/RFID APIs.
// Card first: while idle, watch() polls for an NFC card. A tap reports what is on it ('card_checked'),
// the MOD then starts the QR scan, and after the claim the link is written to whichever card is tapped
// (immediately, if the card is still on the reader).
// A URL short enough for the robot's speech balloon: no scheme or "www.".
export const displayURL = url => String(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '')
const BUSY = ['scanning', 'claiming', 'awaiting_card', 'writing', 'acknowledging']
const WATCH_MS = 500 // the RF field is on only for each brief check
export class EventController {
  // checkpoint(step) marks progress inside a state, so a reset can be traced to the step it interrupted.
  constructor({ camera, decode, post, makeReader, report, schedule, cancel, receipt, now = Date.now, station,
    enableNFCWrite = false, scanTimeout = 30000, checkpoint = () => {}, log = () => {} }) {
    Object.assign(this, { camera, decode, post, makeReader, report, schedule, cancel, receipt, now, station,
      enableNFCWrite, scanTimeout, checkpoint, log })
    this.state = 'idle'
    this.generation = 0
  }
  show(state, text) { this.state = state; this.report(state, text) }
  later(fn, ms) { this.timer = this.schedule(() => { this.timer = undefined; return fn() }, ms) }
  cancelTimer() {
    if (this.timer !== undefined) this.cancel(this.timer)
    this.timer = undefined
  }
  // The reader stays open between uses; only its RF field is switched.
  openReader() { return this.reader ??= this.makeReader() }
  fieldOff() { try { this.reader?.configure({ antenna: false }) } catch {} }
  closeReader() {
    const reader = this.reader
    this.reader = undefined
    if (reader) { try { reader.configure({ antenna: false }) } finally { reader.close() } }
  }
  async stop() {
    ++this.generation
    this.cancelTimer()
    this.closeReader()
    await this.camera.stop()
    this.show('idle', 'Stopped')
  }
  // Idle: look for a card twice a second. Silent until a card is tapped.
  watch() {
    if (!this.enableNFCWrite || BUSY.includes(this.state) || this.state === 'watching') return
    const generation = ++this.generation
    this.cancelTimer()
    this.state = 'watching'
    this.cardChecked = false
    this.later(() => this.pollWatch(generation), 0)
  }
  unwatch() {
    if (this.state !== 'watching') return
    ++this.generation
    this.cancelTimer()
    this.fieldOff()
    this.state = 'idle'
  }
  pollWatch(generation) {
    if (generation !== this.generation) return
    let card
    try {
      const reader = this.openReader()
      reader.configure({ antenna: true })
      card = reader.inspect()
      if (!card) reader.configure({ antenna: false })
    } catch (error) {
      // A failed check is retried quietly; guests only see the result of a tap.
      this.log(`card check failed: ${String(error.message || error)}`)
      this.fieldOff()
      this.later(() => this.pollWatch(generation), 2000)
      return
    }
    if (!card) { this.later(() => this.pollWatch(generation), WATCH_MS); return }
    this.fieldOff()
    if (card.sak !== 0 || !card.formatted) return this.show('card_rejected', "I can't use that card.")
    if (!card.writable) return this.show('card_rejected', 'That card is locked.')
    const uri = card.ndef?.records?.find(record => record.tnf === 1 && record.type === 'U')?.uri
    this.cardChecked = true
    this.show('card_checked', uri ? displayURL(uri) : 'Empty card!')
  }
  async start() {
    if (BUSY.includes(this.state)) return
    const generation = ++this.generation
    this.cancelTimer()
    this.fieldOff()
    try {
      const saved = this.receipt.load()
      if (saved) return await this.acknowledge(saved, generation)
      this.show('scanning', 'Show me your QR code!')
      this.scanDeadline = this.now() + this.scanTimeout
      await this.camera.start({ width: 160, height: 120, imageType: 'rgb565le' })
      if (generation === this.generation) this.later(() => this.scan(generation), 0)
    } catch (error) { await this.fail(error, generation) }
  }
  async fail(error, generation) {
    if (generation !== this.generation) return
    this.closeReader()
    try { await this.camera.stop() } catch {}
    this.show('error', String(error.message || error))
  }
  async scan(generation) {
    if (generation !== this.generation) return
    try {
      // Nobody showed a QR: not an error, just go back to waiting.
      if (this.now() >= this.scanDeadline) {
        await this.camera.stop()
        if (generation === this.generation) this.show('scan_timeout', 'No QR code seen.')
        return
      }
      const frame = await this.camera.capture({ width: 160, height: 120, imageType: 'rgb565le' })
      let payload
      try { if (frame) payload = this.decode(frame) }
      finally { frame?.close?.() }
      if (generation !== this.generation) return
      if (!/^SC1:(?:[A-Za-z0-9_-]{10}|[A-Za-z0-9_-]{22})$/.test(payload || '')) {
        this.later(() => this.scan(generation), 250)
        return
      }
      // Release the frame and stop capture BEFORE network/NFC work.
      await this.camera.stop()
      if (generation !== this.generation) return
      this.show('claiming', 'Got it! Checking...')
      const token = payload.slice(4)
      const claim = await this.post('/api/claim', { token, station: this.station })
      this.checkpoint('claim reply received')
      if (generation !== this.generation) return
      if (!/^https?:\/\/\S+$/.test(claim.url || '') || !claim.lease_id || !Number.isFinite(claim.lease_until))
        throw new Error('Invalid claim response')
      this.claim = { ...claim, token }
      if (!this.enableNFCWrite) {
        this.show('claimed', displayURL(claim.url))
        return
      }
      this.checkpoint('loading NFC reader')
      // A fresh reader (full chip set-up) for writing, as in the build that wrote cards reliably. The idle
      // watch's reader may have switched its field on and off for minutes; reading tolerates that better.
      this.closeReader()
      const reader = this.openReader()
      this.checkpoint('turning on NFC field')
      reader.configure({ antenna: true })
      // A card still resting on the reader is written now; otherwise ask for a tap.
      const card = reader.inspect()
      if (card?.sak === 0 && card.writable) return await this.write(card, generation)
      this.steady = false
      this.show('awaiting_card', this.cardChecked ? 'Tap your card again!' : 'Tap your NFC card!')
      this.later(() => this.pollCard(generation), 250)
    } catch (error) { await this.fail(error, generation) }
  }
  async pollCard(generation) {
    if (generation !== this.generation) return
    try {
      if (this.now() + 10000 >= this.claim.lease_until) throw new Error('Too slow! Start again.')
      let card
      try { card = this.reader.inspect() }
      catch (error) { this.log(`card check failed: ${String(error.message || error)}`) } // card moving: look again
      if (!card) { this.steady = false; this.later(() => this.pollCard(generation), 250); return }
      // Write only once the card is resting: seen on two checks 300 ms apart, not mid-tap.
      if (!this.steady) { this.steady = true; this.later(() => this.pollCard(generation), 300); return }
      if (card.sak !== 0 || !card.formatted || !card.writable) {
        this.show('awaiting_card', card.sak === 0 && card.formatted ? 'That card is locked.' : "I can't use that card.")
        this.later(() => this.pollCard(generation), 1500)
        return
      }
      await this.write(card, generation)
    } catch (error) { await this.fail(error, generation) }
  }
  // Writing needs a closer, steadier card than reading. Retry twice, 200 ms apart, then ask for another tap;
  // the claim stays reserved for this station, so the guest never has to show the QR again.
  async write(card, generation, attempt = 1) {
    if (generation !== this.generation) return
    const claim = this.claim
    if (attempt === 1) this.show('writing', 'Hold still... writing!')
    try {
      this.reader.writeNDEF({ uri: claim.url })
      const uri = this.reader.readNDEF()?.records?.find(record => record.tnf === 1 && record.type === 'U')?.uri
      if (uri === claim.url) {
        const saved = { token: claim.token, station: this.station, lease_id: claim.lease_id, verified: true, uid: card.uidHex }
        // Persist before attempting the cloud acknowledgement; retries do not write again.
        this.receipt.save(saved)
        this.fieldOff()
        return await this.acknowledge(saved, generation)
      }
      this.log(`write attempt ${attempt}: the card read back a different link`)
    } catch (error) { this.log(`write attempt ${attempt} failed: ${String(error.message || error)}`) }
    if (attempt < 3) { this.later(() => this.write(card, generation, attempt + 1), 200); return }
    this.show('awaiting_card', 'Hold it still and tap again!')
    this.steady = false
    this.later(() => this.pollCard(generation), 500)
  }
  async acknowledge(saved, generation) {
    this.show('acknowledging', 'Card written! Saving...')
    let reply
    try { reply = await this.post('/api/complete', saved) }
    catch (error) {
      // Network errors, 5xx, 408 and 429 keep the receipt for the next tap. Any other 4xx is final (reservation
      // or code expired, backend redeployed): the card is written and checked, so drop the receipt rather than
      // retry it on every tap. The guest only misses the card number and thank-you text.
      const { status } = error
      if (!(status >= 400 && status < 500 && status !== 408 && status !== 429)) {
        if (generation === this.generation) this.show('pending_ack', 'Card written! Tap to finish.')
        return
      }
      this.log(`completion refused (${status}): ${String(error.message || error)}`)
    }
    if (generation !== this.generation) return
    this.receipt.clear()
    this.show('done', Number.isInteger(reply?.card) ? `Yay! Card #${reply.card} today!` : 'Yay! Your card is ready!')
  }
}
