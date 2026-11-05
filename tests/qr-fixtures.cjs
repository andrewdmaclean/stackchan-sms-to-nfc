const QRCode = require('qrcode');

const claim = 'SC1:abcdefghijklmnopqrstuv';
function fixture(name, payload = claim, { width = 320, height = 240, scale = 5, bigEndian = false, rotated = false, blank = false } = {}) {
  const matrix = QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules;
  return { name, payload: /^SC1:(?:[A-Za-z0-9_-]{10}|[A-Za-z0-9_-]{22})$/.test(payload) && !blank ? payload : undefined,
    matrix: { size: matrix.size, data: Array.from(matrix.data) }, width, height, scale, bigEndian, rotated, blank };
}
function fixtures() {
  return [fixture('normal'), fixture('big-endian', claim, { bigEndian: true }),
    fixture('rotated', claim, { rotated: true }), fixture('small-frame', claim, { width: 160, height: 120, scale: 3 }),
    fixture('uppercase-token', 'SC1:' + 'A'.repeat(22)),
    fixture('numeric-token', 'SC1:' + '0'.repeat(22)),
    fixture('url-safe-token', 'SC1:' + '-_'.repeat(11)),
    fixture('mixed-token', 'SC1:' + 'Aa0_-z'.repeat(4).slice(0, 22)),
    fixture('short-token', 'SC1:Ab3_-zQ9xK'), fixture('short-token-small-frame', 'SC1:Ab3_-zQ9xK', { width: 160, height: 120, scale: 3 }),
    fixture('unrelated-url', 'https://example.com/not-a-claim'), fixture('malformed-token', 'SC1:too-short'),
    fixture('blank', claim, { blank: true })];
}
module.exports = { claim, fixture, fixtures };
