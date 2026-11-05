// Head motion for the event: an idle "look around", a still forward hold while a guest is being served,
// a small celebration nod, and a torque-off rest. Kept sparse to limit servo wear over a long event day:
// one slow (1 s) glance every 4-7 s, holding forward issues one move, and rest() switches the servos off.
// Glances are direct poses: the host's lookAt() only turns the head for targets over 30 degrees away,
// so most random gaze points never moved it.
export class LookAround {
  // onGlance(ahead) lets the caller change the face with each glance (screen only, no servo cost).
  constructor({ motion, schedule, cancel, random = Math.random, interval = [4000, 7000], onGlance = () => {}, log = () => {} }) {
    Object.assign(this, { motion, schedule, cancel, random, interval, onGlance, log })
    this.active = false
    this.holding = false
    this.closed = false
    this.run = 0
    this.glances = 0
    this.side = 1
  }
  between(low, high) { return low + this.random() * (high - low) }
  // Alternate left/right glances of 9-29 degrees, slightly up toward standing guests; every fourth faces the aisle.
  look() {
    const ahead = ++this.glances % 4 === 0
    this.side = -this.side
    const y = ahead ? 0 : this.side * this.between(0.15, 0.5)
    this.pose(this.between(-0.15, 0.03), 1, y).catch(error => this.log(error))
    this.onGlance(ahead)
  }
  pose(p, time, y = 0) {
    return this.motion.setPose({ position: { ...this.motion.pose?.body?.position }, rotation: { y, p, r: 0 } }, time)
  }
  torqueOn() {
    return this.torque ??= this.motion.setTorque(true).catch(error => { this.torque = undefined; throw error })
  }
  stopGazing() {
    const run = ++this.run
    this.active = false
    if (this.timer !== undefined) this.cancel(this.timer)
    this.timer = undefined
    this.motion.lookAway()
    return run
  }
  async resume() {
    if (this.active || this.closed) return
    const run = this.stopGazing()
    this.active = true
    this.holding = false
    try { await this.torqueOn() }
    catch (error) { this.active = false; this.log(error); return }
    const next = () => {
      this.timer = this.schedule(() => {
        this.timer = undefined
        if (run !== this.run) return
        this.look()
        next()
      }, this.between(...this.interval))
    }
    if (run !== this.run) return
    this.look()
    next()
  }
  // Face forward and hold still (camera aimed at the guest, card tap not a moving target).
  async pause() {
    const run = this.stopGazing()
    if (this.holding || this.closed) return
    this.holding = true
    try {
      await this.torqueOn()
      if (run === this.run) await this.pose(0, 0.5)
    } catch (error) { this.holding = false; this.log(error) }
  }
  // Two small nods from the forward hold; false if something else took over the head meanwhile.
  async nod() {
    if (!this.holding || this.closed) return false
    const run = this.run
    try {
      for (let i = 0; i < 2 && run === this.run; i++) {
        await this.pose(-0.12, 0.2)
        if (run === this.run) await this.pose(0, 0.2)
      }
    } catch (error) { this.log(error) }
    return run === this.run
  }
  // Nap: no gaze changes and servos unpowered until the next resume() or pause().
  async rest() {
    this.stopGazing()
    this.holding = false
    if (this.torque === undefined) return
    this.torque = undefined
    try { await this.motion.setTorque(false) } catch (error) { this.log(error) }
  }
  async close() {
    this.closed = true
    await this.rest()
  }
}
