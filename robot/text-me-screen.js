import 'piu/MC'
import qr from 'text-me-qr'

// The "text me your link" screen shown between glances: the robot's SMS number as a QR code (generated at
// build time into text-me-qr.js) above a caption. Each horizontal run of dark modules is one fillColor, about
// 150 rectangles for a 21x21 code. The face is hidden meanwhile, which keeps the frame well inside Piu's
// 8 KB display list (long balloon text over the face overflowed it and restarted the robot).
const QUIET = 2 // light modules around the code
// Light theme: Ink modules on White, caption in Twilio Red.
export default function createSMSQRView({ caption, font, color = '#EF223A' }) {
  if (!qr) return
  const cells = qr.size + QUIET * 2
  const scale = Math.floor(176 / cells)
  const side = cells * scale
  const runs = []
  qr.rows.forEach((row, y) => {
    for (let x = 0; x < qr.size;) {
      if (row[x] !== '1') { x++; continue }
      let width = 1
      while (row[x + width] === '1') width++
      runs.push((x + QUIET) * scale, (y + QUIET) * scale, width * scale)
      x += width
    }
  })
  class QRBehavior extends Behavior {
    onDraw(port) {
      port.fillColor('#ffffff', 0, 0, side, side)
      for (let i = 0; i < runs.length; i += 3) port.fillColor('#000D25', runs[i], runs[i + 1], runs[i + 2], scale)
    }
  }
  return new Container(null, {
    left: 0, right: 0, top: 0, bottom: 0, skin: new Skin({ fill: '#ffffff' }),
    contents: [
      new Port(null, { top: 12, width: side, height: side, Behavior: QRBehavior }),
      new Label(null, { left: 0, right: 0, bottom: 12, height: 32, style: new Style({ font, color }), string: caption }),
    ],
  })
}
