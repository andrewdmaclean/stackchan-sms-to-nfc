// Twilio Functions adapter for the shared event handlers: live Sync, device bearer auth, HTTP responses.
// store.private.js and event.private.js are copies of backend/store.cjs and handlers.cjs (made by deploy.sh).
const crypto = require('crypto');
const { Store, EventError } = require(Runtime.getFunctions()['store'].path);
const { createFunctions, ticketPage, claimQR } = require(Runtime.getFunctions()['event'].path);

function appFor(context) {
  const client = context.getTwilioClient();
  const store = new Store(null, { sync: client.sync.v1.services(context.SYNC_SERVICE_SID), timeZone: context.EVENT_TIMEZONE || undefined });
  const baseURL = `https://${context.DOMAIN_NAME}`;
  // Thank the guest once their card is written. A failed text never fails the robot's completion.
  const notify = async item => {
    if (context.EVENT_THANK_YOU_SMS === 'off') return;
    try {
      await client.messages.create({ from: context.EVENT_TWILIO_NUMBER, to: item.from,
        body: `StackChan wrote your NFC card! Tap it on a phone to open ${item.url} — you were card #${item.card} today.` });
    } catch (error) { console.error(error); }
  };
  const qrImageURL = context.EVENT_MMS === 'off' ? undefined : token => `${baseURL}/qr?t=${token}`;
  return { store, functions: createFunctions({ store, baseURL, ticketURL: token => `${baseURL}/ticket?t=${token}`, qrImageURL, notify }) };
}
function respond(status, body, type = 'application/json') {
  const response = new Twilio.Response();
  response.setStatusCode(status);
  response.appendHeader('Content-Type', type);
  response.appendHeader('Cache-Control', 'no-store');
  response.appendHeader('Referrer-Policy', 'no-referrer');
  response.appendHeader('X-Content-Type-Options', 'nosniff');
  response.setBody(body); // Twilio serializes objects itself when the type is JSON.
  return response;
}
// Store errors carry their own HTTP status; anything else (including Sync failures) is internal.
function failure(error, type = 'application/json') {
  if (error instanceof EventError) return respond(error.status, type === 'application/json' ? { error: error.message } : error.message, type);
  console.error(error);
  return respond(500, type === 'application/json' ? { error: 'Internal error.' } : 'Internal error.', type);
}
function authorized(context, event) {
  const secret = context.EVENT_DEVICE_TOKEN;
  const expected = Buffer.from(`Bearer ${secret || ''}`), actual = Buffer.from(String(event.request?.headers?.authorization || ''));
  return Boolean(secret) && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
// Robot endpoints: POST JSON with the shared device bearer token.
function deviceHandler(name) {
  return async (context, event, callback) => {
    if (!authorized(context, event)) return callback(null, respond(401, { error: 'Unauthorized.' }));
    try {
      const { functions } = appFor(context);
      const input = name === 'claim' ? { token: event.token, station: event.station }
        : { token: event.token, station: event.station, lease_id: event.lease_id, uid: event.uid,
            verified: event.verified === true || event.verified === 'true' };
      const result = await functions[name](input);
      return callback(null, respond(result.status, result.body));
    } catch (error) { return callback(null, failure(error)); }
  };
}
module.exports = { appFor, respond, failure, deviceHandler, ticketPage, claimQR };
