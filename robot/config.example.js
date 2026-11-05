// Copy to config.js before preparing the community checkout. Never commit secrets.
export default {
  host: '192.168.1.20',
  port: 8791,
  secure: false, // LAN bench only. Use HTTPS with a trusted certificate for the event.
  token: 'replace-with-EVENT_DEVICE_TOKEN',
  station: 'stackchan-01',
  // The Twilio number guests text their link to; shown on screen as a "text me" QR between glances.
  smsNumber: '+15555550100',
  // Seconds with no guest before the robot naps (servos off) until a head pat wakes it.
  napAfterSeconds: 180,
  // false: never move or power the head servos (for diagnosing resets).
  motion: true,
  // Seconds the camera looks for a QR after a head pat before going back to waiting.
  scanTimeoutSeconds: 30,
  // Leave false until scanning/claiming works; turn on only with writable test tags.
  enableNFCWrite: false,
}
