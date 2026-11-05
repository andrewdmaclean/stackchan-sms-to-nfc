const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { MockSyncService } = require('../backend/mock-sync.cjs');

// Run the Twilio Function files in Node with the Runtime/Twilio globals they use and the local Sync mock.
const dir = path.resolve(__dirname, '../backend');
const fns = path.join(dir, 'functions');
globalThis.Runtime = { getFunctions: () => ({
  runtime: { path: path.join(fns, 'runtime.private.js') },
  store: { path: path.join(dir, 'store.cjs') },
  event: { path: path.join(dir, 'handlers.cjs') },
}) };
globalThis.Twilio = { Response: class {
  constructor() { this.statusCode = 200; this.headers = {}; this.body = ''; }
  setStatusCode(code) { this.statusCode = code; }
  appendHeader(name, value) { this.headers[name] = value; }
  // Like Twilio's Response: a JSON content type always serializes, so a pre-stringified body is double-encoded.
  setBody(body) { this.body = this.headers['Content-Type'] === 'application/json' ? JSON.stringify(body) : body; }
} };
const call = (file, context, event) => new Promise((resolve, reject) =>
  require(path.join(fns, file)).handler(context, event, (error, response) => error ? reject(error) : resolve(response)));

test('Twilio Functions run the SMS → ticket → claim → complete flow against Sync', async () => {
  const sync = new MockSyncService(null), texts = [];
  const context = { SYNC_SERVICE_SID: 'IS00', DOMAIN_NAME: 'stackchan-event-0000.twil.io', EVENT_DEVICE_TOKEN: 'device-secret',
    EVENT_TWILIO_NUMBER: '+15555550100', getTwilioClient: () => ({ sync: { v1: { services: () => sync } },
      messages: { create: async message => { texts.push(message); } } }) };
  const device = { request: { headers: { authorization: 'Bearer device-secret' } } };

  const other = await call('sms.protected.js', context, { MessageSid: 'SM1', From: '+16045550100', To: '+15555550199', Body: 'https://example.com/x' });
  assert.equal(other.body, '<Response/>');
  const sms = await call('sms.protected.js', context, { MessageSid: 'SM1', From: '+16045550100', To: '+15555550100', Body: ' https://example.com/x ' });
  assert.equal(sms.headers['Content-Type'], 'text/xml');
  const media = sms.body.match(/<Media>https:\/\/stackchan-event-0000\.twil\.io\/qr\?t=([A-Za-z0-9_-]{10})<\/Media>/);
  assert.ok(media, 'the QR is attached as an MMS picture');
  assert.match(sms.body, /<Body>Pat StackChan's head and show it this QR, then tap your NFC card\.<\/Body>/);
  assert.ok(!sms.body.includes('/ticket?t='), 'the MMS reply carries no link');
  const picture = await call('qr.js', context, { t: media[1] });
  assert.equal(picture.headers['Content-Type'], 'image/png');
  // Read the MMS picture with the robot's own decoder (cam2qr).
  const { PNG } = require('pngjs');
  const png = PNG.sync.read(picture.body);
  const rgb565 = new Uint8Array(png.width * png.height * 2);
  for (let i = 0; i < png.width * png.height; i++) {
    const v = ((png.data[4 * i] >> 3) << 11) | ((png.data[4 * i + 1] >> 2) << 5) | (png.data[4 * i + 2] >> 3);
    rgb565[2 * i] = v & 255; rgb565[2 * i + 1] = v >> 8;
  }
  require('../scripts/build-cam2qr.cjs')(path.resolve(__dirname, '../robot/vendor'));
  const { default: decode } = await import('../robot/vendor/cam2qr.js');
  const decoded = decode({ data: rgb565, width: png.width, height: png.height }, { tryInverted: false });
  assert.deepEqual([decoded.text, decoded.version, decoded.segments.map(segment => segment.mode)], ['SC1:' + media[1], 1, ['byte']]);
  assert.equal((await call('qr.js', context, { t: 'nope' })).statusCode, 404);
  const token = media[1];
  const bad = await call('sms.protected.js', context, { MessageSid: 'SM2', From: '+16045550100', To: '+15555550100', Body: 'hello' });
  assert.match(bad.body, /<Message>Send one complete/);

  const page = await call('ticket.js', context, { t: token });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<img src="data:image\/png;base64,/);
  assert.match(page.headers['Content-Security-Policy'], /img-src data:/);
  assert.equal((await call('ticket.js', context, { t: 'x' })).statusCode, 404);

  assert.equal((await call('api/claim.js', context, { token, station: 'stackchan-01', request: { headers: {} } })).statusCode, 401);
  assert.equal((await call('api/claim.js', context, { token, station: 'stackchan-01', request: { headers: { authorization: 'Bearer device-secre' } } })).statusCode, 401);
  const missing = await call('api/claim.js', context, { ...device, token: 'a'.repeat(22), station: 'stackchan-01' });
  assert.deepEqual([missing.statusCode, JSON.parse(missing.body).error], [404, 'Claim not found or expired.']);
  const claim = await call('api/claim.js', context, { ...device, token, station: 'stackchan-01' });
  const lease = JSON.parse(claim.body);
  assert.deepEqual([claim.statusCode, lease.url], [200, 'https://example.com/x']);

  // Form-encoded or JSON bodies: a "true" string still counts as the robot's verified report.
  const done = await call('api/complete.js', context, { ...device, token, station: 'stackchan-01', lease_id: lease.lease_id, verified: 'true', uid: '04AABBCCDDEEFF' });
  assert.deepEqual([done.statusCode, JSON.parse(done.body)], [200, { status: 'complete', card: 1 }]);
  assert.deepEqual(texts.map(({ from, to }) => [from, to]), [['+15555550100', '+16045550100']]);
  assert.match(texts[0].body, /https:\/\/example\.com\/x .*card #1 today/);
  // A retried acknowledgement keeps its number and does not text the guest again.
  const again = await call('api/complete.js', context, { ...device, token, station: 'stackchan-01', lease_id: lease.lease_id, verified: true, uid: '04AABBCCDDEEFF' });
  assert.deepEqual([again.statusCode, JSON.parse(again.body), texts.length], [200, { status: 'complete', card: 1 }, 1]);
  assert.equal((await call('ticket.js', context, { t: token })).statusCode, 410);
  assert.equal((await call('api/claim.js', context, { ...device, token, station: 'stackchan-01' })).statusCode, 409);
});

test('Twilio device endpoints fail closed without a configured token and hide internal errors', async () => {
  const broken = { getTwilioClient: () => { throw new Error('secret detail'); }, DOMAIN_NAME: 'x.twil.io', EVENT_DEVICE_TOKEN: 't' };
  assert.equal((await call('api/claim.js', { ...broken, EVENT_DEVICE_TOKEN: '' }, { request: { headers: { authorization: 'Bearer ' } } })).statusCode, 401);
  const original = console.error; console.error = () => {};
  try {
    const failed = await call('api/claim.js', broken, { request: { headers: { authorization: 'Bearer t' } }, token: 'a'.repeat(22), station: 's' });
    assert.deepEqual([failed.statusCode, JSON.parse(failed.body)], [500, { error: 'Internal error.' }]);
  } finally { console.error = original; }
});

test('the MOD bundles the pinned Amazon Root CA 1 that anchors *.twil.io', async () => {
  const { pathToFileURL } = require('node:url');
  const ca = (await import(pathToFileURL(path.resolve(__dirname, '../robot/vendor/amazon-root-ca1.js')).href)).default;
  const sha = require('node:crypto').createHash('sha256').update(Buffer.from(ca)).digest('hex');
  assert.equal(sha, '8ecde6884f3d87b1125ba31ac3fcb13d7016de7f57cc904fe1cb97c6ae98196e');
});

test('cards are numbered per event day, and thank-you texts can be switched off', async () => {
  const sync = new MockSyncService(null), texts = [];
  const context = { SYNC_SERVICE_SID: 'IS00', DOMAIN_NAME: 'x.twil.io', EVENT_DEVICE_TOKEN: 'd', EVENT_TWILIO_NUMBER: '+15555550100',
    EVENT_THANK_YOU_SMS: 'off', EVENT_MMS: 'off', getTwilioClient: () => ({ sync: { v1: { services: () => sync } }, messages: { create: async m => { texts.push(m); } } }) };
  const device = { request: { headers: { authorization: 'Bearer d' } } };
  const cards = [];
  for (const sid of ['SM10', 'SM11']) {
    const sms = await call('sms.protected.js', context, { MessageSid: sid, From: '+16045550100', To: '+15555550100', Body: 'https://example.com/' + sid });
    const token = sms.body.match(/t=([A-Za-z0-9_-]{10})</)[1];
    const lease = JSON.parse((await call('api/claim.js', context, { ...device, token, station: 's1' })).body);
    cards.push(JSON.parse((await call('api/complete.js', context, { ...device, token, station: 's1', lease_id: lease.lease_id, verified: true, uid: '04AABBCCDD' })).body).card);
  }
  assert.deepEqual(cards, [1, 2]);
  assert.equal(texts.length, 0);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
  assert.equal((await sync.syncMaps('event_stats').syncMapItems(day).fetch()).data.cards, 2);
});

test('claim QRs are a single byte-mode segment, even for tokens the QR library would split', () => {
  const QRCode = require('qrcode');
  const { claimQR } = require('../backend/handlers.cjs');
  assert.deepEqual(QRCode.create('SC1:ScyLk__NVL7gel3oPNGLCg', { errorCorrectionLevel: 'M' }).segments.map(s => s.mode.id), ['Alphanumeric', 'Byte']);
  for (const token of ['ScyLk__NVL7gel3oPNGLCg', 'A'.repeat(22), '0'.repeat(22)])
    assert.deepEqual(QRCode.create(claimQR(token), { errorCorrectionLevel: 'M' }).segments.map(s => s.mode.id), ['Byte'], token);
});
