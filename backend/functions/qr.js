// GET /qr?t=<token>: the claim QR as a PNG, attached to the SMS reply as an MMS picture.
const QRCode = require('qrcode');
const { appFor, respond, failure, claimQR } = require(Runtime.getFunctions()['runtime'].path);
exports.handler = async (context, event, callback) => {
  try {
    const item = await appFor(context).store.get(String(event.t || ''));
    if (item.status === 'complete') return callback(null, respond(410, 'This request has already been written.', 'text/plain; charset=utf-8'));
    const png = await QRCode.toBuffer(claimQR(item.token), { width: 600, margin: 4, errorCorrectionLevel: 'M' });
    return callback(null, respond(200, png, 'image/png'));
  } catch (error) { return callback(null, failure(error, 'text/plain; charset=utf-8')); }
};
