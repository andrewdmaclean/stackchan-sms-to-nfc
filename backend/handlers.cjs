// Shared Function business handlers. HTTP authentication belongs to the adapter.
// Responses are platform-neutral; the local server and Twilio Functions wrap them.
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
// Claim QR content as one byte-mode segment. Left to itself the QR library splits runs like "SC1:S" into
// alphanumeric/numeric segments, which the robot's decoders handle less reliably than plain bytes.
const claimQR = token => [{ data: 'SC1:' + token, mode: 'byte' }];
// The QR page shown on the guest's phone; qrSource is an image URL or data: URI.
const ticketPage = qrSource => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your StackChan QR</title><style>body{margin:0;padding:24px 12px;background:white;color:#111;text-align:center;font:20px system-ui}img{display:block;width:min(92vw,560px);height:auto;margin:20px auto}p{max-width:34ch;margin:16px auto}</style><h1>Show this to StackChan</h1><img src="${escape(qrSource)}" alt="Your single-use claim QR code"><p>Hold your phone steady, then tap your NFC card when invited.</p><p>Keep this page private. It expires after 24 hours.</p></html>`;
// notify(item) runs once per card, after it is numbered (for example, a thank-you SMS).
// qrImageURL(token), when given, sends the QR as an MMS picture and no link; otherwise the text links to the QR page.
function createFunctions({ store, baseURL, ticketURL = token => `${baseURL}/ticket/${token}`, qrImageURL, notify = async () => {} }) {
  const ticket = item => ({ token: item.token, qr_payload: 'SC1:' + item.token,
    ticket_url: ticketURL(item.token), expires: item.expires });
  return {
    ticket,
    async sms(event) {
      try {
        const item = await store.create({ sid: event.MessageSid, from: event.From, body: event.Body });
        const link = escape(ticket(item).ticket_url);
        const body = qrImageURL
          ? `<Response><Message><Body>Pat StackChan's head and show it this QR, then tap your NFC card.</Body><Media>${escape(qrImageURL(item.token))}</Media></Message></Response>`
          : `<Response><Message>Pat StackChan's head, show it this QR, then tap your NFC card: ${link}</Message></Response>`;
        return { status: 200, type: 'text/xml', ticket: ticket(item), body };
      } catch (error) {
        if (error.status !== 400) throw error;
        return { status: 200, type: 'text/xml', body: `<Response><Message>${escape(error.message)}</Message></Response>` };
      }
    },
    async claim(event) {
      const item = await store.claim(event.token, event.station);
      return { status: 200, body: { url: item.url, lease_id: item.leaseId, lease_until: item.leaseUntil } };
    },
    async complete(event) {
      await store.finish(event.token, { station: event.station, leaseId: event.lease_id, verified: event.verified, uid: event.uid });
      const { item, assigned } = await store.number(event.token);
      if (assigned) await notify(item);
      return { status: 200, body: { status: item.status, card: item.card } };
    },
  };
}
module.exports = { createFunctions, ticketPage, claimQR };
