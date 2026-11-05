import Timer from 'timer'
import Preference from 'preference'
import Modules from 'modules'
import config from 'event-config'
import { EventController } from './controller'
import { createPost } from './http'
import { LookAround } from './look-around'

// Shown in the robot's log and the gallery name; scripts/add-to-gallery.cjs reads it from here. Bump per build.
const VERSION = '0.5.3'
const ACTIVE = ['scanning', 'claiming', 'awaiting_card', 'writing', 'acknowledging']
// Values of the host's face-state Emotion; hand names are its built-in on-screen hand animations.
const Emotion = { NEUTRAL: 0, SAD: 2, HAPPY: 3, SLEEPY: 4, DOUBTFUL: 5, HOT: 7 }
// Twilio brand themes: only Twilio Red, Ink and White. `surface` is the face background (and balloon text);
// `content` is the eyes, mouth and balloon. Red attracts attention, dark is the default, light gives pacing.
// Scanning stays dark so a bright screen does not reflect off the guest's phone next to the camera.
const RED = [0xef, 0x22, 0x3a], INK = [0x00, 0x0d, 0x25], WHITE = [0xff, 0xff, 0xff]
const Theme = { RED: { surface: RED, content: WHITE }, DARK: { surface: INK, content: WHITE }, LIGHT: { surface: WHITE, content: INK } }
const FACES = {
  idle: [Emotion.NEUTRAL, 'none', Theme.RED], scan_timeout: [Emotion.NEUTRAL, 'none', Theme.RED],
  card_checked: [Emotion.HAPPY, 'none', Theme.DARK], scanning: [Emotion.NEUTRAL, 'none', Theme.DARK],
  claiming: [Emotion.DOUBTFUL, 'thinking', Theme.DARK], acknowledging: [Emotion.HAPPY, 'none', Theme.DARK],
  pending_ack: [Emotion.DOUBTFUL, 'none', Theme.DARK],
  awaiting_card: [Emotion.HAPPY, 'none', Theme.LIGHT], writing: [Emotion.HOT, 'none', Theme.LIGHT],
  done: [Emotion.HAPPY, 'clap', Theme.RED], claimed: [Emotion.HAPPY, 'none', Theme.RED],
  card_rejected: [Emotion.DOUBTFUL, 'none', Theme.DARK], error: [Emotion.SAD, 'none', Theme.DARK],
  napping: [Emotion.SLEEPY, 'none', Theme.DARK],
}
const BALLOON_LIMIT = 28
const RESULT_MS = 8000 // a result stays readable this long before inviting the next guest
const CELEBRATE_MS = 3000
const ATTRACT_FACE_MS = 12000 // while waiting: face and glances this long,
const ATTRACT_QR_MS = 10000 // then the "text me" QR this long
const SMS_CAPTION = 'Scan me to text your link!'
const CARD_INFO_MS = 2500 // what a tapped card holds stays up this long before the QR scan starts

let cleanup
export function onContextCreated(robot) {
  cleanup?.()
  // Open Sans 24 px is built into the CoreS3 and simulator hosts (ASCII only). The balloon measures its font
  // when created, so a missing font throws here and the default 12 px font is used instead.
  // Long balloon text overflows Piu's 8 KB display list while drawing ("display list overflowed"): an
  // uncatchable abort that restarts the robot. The face's vector eyes, mouth and hands share that list, so
  // the room left for text varies: 42 characters rendered once, while 42-56 crashed in either font.
  // Every balloon is therefore capped at 28 characters; the full text goes to the log.
  let font = '24px Open Sans'
  const say = message => {
    const text = message.length > BALLOON_LIMIT ? message.slice(0, BALLOON_LIMIT - 3).trimEnd() + '...' : message
    if (text !== message) trace(`[event] balloon shortened: ${message}\n`)
    if (font) {
      try { robot.ui.showBalloon(text, { font }); return }
      catch (error) { trace(`[event] ${font} unavailable: ${String(error)}\n`); font = undefined }
    }
    robot.ui.showBalloon(text)
  }
  if (!robot.camera?.available) {
    say('Event MOD requires the CoreS3 camera.')
    return
  }
  if (config.enableNFCWrite && !device.sensor?.RFID) {
    say('NFC writer requires M5StackChan CoreS3.')
    return
  }
  // express() sets the theme for each mode. The host draws the face background and balloon text in
  // `secondary`, and the features and balloon in `primary`.
  robot.face?.setColor('primary', ...WHITE)
  robot.face?.setColor('secondary', ...RED)
  // The last step reached is kept in flash, so after an unexpected reset the robot can say where it stopped.
  const step = {
    mark(name) { trace(`[event] step: ${name}\n`); try { Preference.set('event', 'step', name) } catch {} },
    clear() { try { Preference.delete('event', 'step') } catch {} },
  }
  const interrupted = Preference.get('event', 'step')
  step.clear()
  const napAfterMs = (config.napAfterSeconds ?? 180) * 1000
  // Card first when the NFC writer is on: a tap starts the flow. A head pat is the backup (and the only start
  // for the NFC-off scanner test).
  const INVITE = config.enableNFCWrite ? 'Tap your card on me!' : 'Pat my head to start!'
  let decoder, stageTimer, inviteTimer, napTimer, celebrateTimer, cardTimer, attractTimer, qrView, qrShowing = false
  let starting = false, startGeneration = 0, closed = false, waiting = false, napping = false
  const express = state => {
    const [emotion, hands, theme] = FACES[state] ?? FACES.idle
    robot.face?.setEmotion(emotion)
    robot.face?.setColor('primary', ...theme.content)
    robot.face?.setColor('secondary', ...theme.surface)
    robot.ui.setHandAnimation?.(hands)
  }
  const lights = robot.lighting?.led?.head ? robot.lighting : undefined
  // Look around while waiting; face forward from a head pat until the guest is done (or it fails or stops).
  // While waiting for a guest, each glance also changes the face: a smile toward the aisle, mostly neutral to the sides.
  const glanceFaces = [Emotion.NEUTRAL, Emotion.NEUTRAL, Emotion.DOUBTFUL, Emotion.HAPPY]
  const onGlance = ahead => {
    if (waiting) robot.face?.setEmotion(ahead ? Emotion.HAPPY : glanceFaces[Math.floor(Math.random() * glanceFaces.length)])
  }
  // config.motion === false keeps the servos untouched (diagnosing resets).
  const lookAround = robot.motion && config.motion !== false ? new LookAround({ motion: robot.motion, schedule: (fn, ms) => Timer.set(fn, ms),
    cancel: timer => Timer.clear(timer), onGlance, log: error => trace(`[event] head motion: ${String(error)}\n`) })
    : { pause: async () => {}, resume: async () => {}, rest: async () => {}, close: async () => {}, nod: async () => false }
  const clearTimers = () => {
    for (const timer of [inviteTimer, napTimer, celebrateTimer, cardTimer, attractTimer]) if (timer !== undefined) Timer.clear(timer)
    inviteTimer = napTimer = celebrateTimer = cardTimer = attractTimer = undefined
    hideQR()
    lights?.lightOff('head')
  }
  // Between glances, swap the face for a QR that opens a text to the robot's number. The head holds still
  // so the screen is easy to scan; a card tap or head pat brings the face straight back (clearTimers).
  const showQR = () => {
    try { qrView ??= Modules.importNow('text-me-screen')({ caption: SMS_CAPTION, font }) }
    catch (error) { trace(`[event] text-me QR unavailable: ${String(error)}\n`); qrView = null }
    if (!qrView) return
    robot.ui.hideBalloon?.()
    robot.ui.setMain(qrView)
    qrShowing = true
    if (!napping) void lookAround.pause() // a napping head stays at rest
  }
  function hideQR() {
    if (!qrShowing) return
    qrShowing = false
    robot.ui.showFace()
  }
  const attract = () => {
    attractTimer = Timer.set(() => {
      attractTimer = undefined
      if (!waiting && !napping) return
      if (qrShowing) {
        hideQR()
        say(napping ? NAP_TEXT : INVITE)
        if (!napping) void lookAround.resume()
      } else showQR()
      attract()
    }, qrShowing ? ATTRACT_QR_MS : ATTRACT_FACE_MS)
  }
  const invite = () => { waiting = true; napping = false; express('idle'); say(INVITE); controller.watch(); attract() }
  // Rest the servos when nobody has come by for a while. The card watch continues, so a tap (or a head pat)
  // wakes it straight into the flow.
  const NAP_TEXT = config.enableNFCWrite ? 'Zzz... tap your card!' : 'Zzz... pat my head!'
  const nap = () => {
    waiting = false
    napping = true
    if (qrShowing) { hideQR(); attract() }
    express('napping')
    void lookAround.rest()
    say(NAP_TEXT)
  }
  const waitForGuest = delay => {
    clearTimers()
    if (delay) inviteTimer = Timer.set(() => { inviteTimer = undefined; invite() }, delay)
    napTimer = Timer.set(() => { napTimer = undefined; nap() }, delay + napAfterMs)
  }
  const celebrate = () => {
    lights?.lightRainbow('head')
    celebrateTimer = Timer.set(() => { celebrateTimer = undefined; lights?.lightOff('head'); robot.ui.setHandAnimation?.('none') }, CELEBRATE_MS)
    void lookAround.pause().then(() => lookAround.nod()).then(still => still && lookAround.resume())
  }
  const receipt = {
    load() { const saved = Preference.get('event', 'receipt'); return saved ? JSON.parse(saved) : undefined },
    save(value) { Preference.set('event', 'receipt', JSON.stringify(value)) },
    clear() { Preference.delete('event', 'receipt') },
  }
  const controller = new EventController({
    camera: robot.camera, post: createPost(config),
    decode: frame => {
      const started = Date.now()
      try { return decoder.decode(frame) } finally { trace(`[event] decode ${Date.now() - started} ms\n`) }
    },
    station: config.station, enableNFCWrite: config.enableNFCWrite, scanTimeout: (config.scanTimeoutSeconds ?? 30) * 1000,
    makeReader: () => {
      // The stock ST25R3916 driver checks CRC on the tag's 4-bit WRITE ACK.
      // This MOD-local copy fixes that receive setting without reflashing the host.
      const RFID = Modules.importNow('vendor/st25r3916')
      return new RFID({ sensor: { ...device.i2c.internal, io: device.io.SMBus, address: 0x50, hz: 400_000 } })
    },
    report(state, text) {
      trace(`[event] ${state}: ${text}\n`)
      if (closed) return
      waiting = napping = false
      say(text)
      express(state)
      if (ACTIVE.includes(state)) {
        step.mark(state)
        clearTimers()
        // The camera needs the head still and forward. Network and NFC run with the servos off: the reader's RF
        // field, Wi-Fi/TLS and holding servos together are the suspected cause of resets after a scan.
        void (state === 'scanning' ? lookAround.pause() : lookAround.rest())
        return
      }
      // A tapped card: show what it holds, face forward for the camera, then ask for the QR.
      if (state === 'card_checked') {
        clearTimers()
        void lookAround.pause()
        cardTimer = Timer.set(() => { cardTimer = undefined; startScan() }, CARD_INFO_MS)
        return
      }
      step.clear()
      waitForGuest(state === 'claimed' ? 15000 : ['idle', 'scan_timeout', 'card_rejected'].includes(state) ? 3000 : RESULT_MS)
      if (state === 'done') celebrate()
      else void lookAround.resume()
    },
    schedule: (fn, ms) => Timer.set(fn, ms), cancel: timer => Timer.clear(timer),
    receipt, checkpoint: name => step.mark(name), log: message => trace(`[event] ${message}\n`),
  })
  const startScan = () => {
    if (closed || starting || ACTIVE.includes(controller.state)) return
    starting = true
    waiting = napping = false
    controller.unwatch()
    clearTimers()
    express('scanning')
    void lookAround.pause()
    const attempt = ++startGeneration
    const failed = error => {
      if (attempt !== startGeneration) return
      starting = false
      trace(`[event] start failed: ${String(error)}\n`)
      express('error')
      say(`Scan start failed: ${String(error.message || error)}`)
      waitForGuest(RESULT_MS)
      void lookAround.resume()
    }
    const stage = (message, action) => {
      say(message)
      trace(`[event] ${message}\n`)
      // Give the physical screen time to paint before potentially blocking work.
      stageTimer = Timer.set(() => {
        stageTimer = undefined
        if (attempt !== startGeneration) return
        try {
          const result = action()
          if (result && typeof result.catch === 'function') result.catch(failed)
        } catch (error) { failed(error) }
      }, 250)
    }
    const startController = () => stage('Starting camera...', async () => {
      try { await controller.start() } finally { starting = false }
    })
    robot.ui.closeDrawer()
    stage('Checking saved card...', () => {
      // A verified write can be acknowledged without loading the decoder.
      if (receipt.load()) return startController()
      if (decoder) return startController()
      stage('Loading QR decoder...', () => {
        const ClaimQRDecoder = Modules.importNow('qr-decoder')
        decoder = new ClaimQRDecoder()
        startController()
      })
    })
  }
  // A head pat (tap or stroke) skips the card check and goes straight to the QR scan. The host pauses the
  // head sensor while the camera runs.
  const unsubscribe = robot.input?.touchPanel?.subscribe?.(event => {
    if (!event.tap && event.gesture !== 'forwardSwipe' && event.gesture !== 'backwardSwipe') return
    trace(`[event] head ${event.tap ? 'tap' : event.gesture}\n`)
    startScan()
  })
  robot.ui.drawer.addDrawerButton({ key: 'event-scan', label: 'Scan / retry', callback: () => {
    trace('[event] Scan / retry pressed\n')
    startScan()
  } })
  robot.ui.drawer.addDrawerButton({ key: 'event-stop', label: 'Stop event', callback: () => {
    ++startGeneration
    if (stageTimer !== undefined) Timer.clear(stageTimer)
    stageTimer = undefined
    starting = false
    return controller.stop()
  } })
  cleanup = () => {
    closed = true
    ++startGeneration
    unsubscribe?.()
    clearTimers()
    if (stageTimer !== undefined) Timer.clear(stageTimer)
    void lookAround.close()
    void controller.stop()
    decoder?.close()
    robot.ui.drawer.removeDrawerButton('event-scan')
    robot.ui.drawer.removeDrawerButton('event-stop')
  }
  trace(`[event] ready; NFC writing ${config.enableNFCWrite ? 'enabled' : 'disabled'}; v${VERSION}\n`)
  waitForGuest(0)
  invite()
  if (interrupted) {
    trace(`[event] previous run reset during: ${interrupted}\n`)
    say(`Reset at: ${interrupted}`)
  }
  void lookAround.resume()
}
