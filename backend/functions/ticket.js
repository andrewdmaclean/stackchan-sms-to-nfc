// GET /ticket?t=<token>: the guest's QR page. The QR is an inline PNG, so there is no second route.
const QRCode = require('qrcode');
const { appFor, respond, failure, ticketPage, claimQR } = require(Runtime.getFunctions()['runtime'].path);
exports.handler = async (context, event, callback) => {
  const html = 'text/html; charset=utf-8';
  try {
    const item = await appFor(context).store.get(String(event.t || ''));
    if (item.status === 'complete') return callback(null, respond(410, 'This request has already been written.', 'text/plain; charset=utf-8'));
    const qr = await QRCode.toDataURL(claimQR(item.token), { width: 720, margin: 4, errorCorrectionLevel: 'M' });
    const response = respond(200, ticketPage(qr), html);
    response.appendHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'");
    return callback(null, response);
  } catch (error) { return callback(null, failure(error, 'text/plain; charset=utf-8')); }
};
