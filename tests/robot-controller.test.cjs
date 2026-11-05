const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { fixture, fixtures } = require('./qr-fixtures.cjs');
const { Store } = require('../backend/store.cjs');
const { createFunctions } = require('../backend/handlers.cjs');

test('the robot decoder (cam2qr) handles camera frames without browser, Node or native APIs', async () => {
  require('../scripts/build-cam2qr.cjs')(path.join(__dirname, '../robot/vendor'));
  const { default: Decoder } = await import('../robot/qr-decoder.js');
  const { runQRChecks } = await import('./qr-runtime-check.mjs');
  const result = runQRChecks(Decoder, fixtures());
  assert.equal(result.results.length, fixtures().length);
  assert.equal(result.repeated_frames, 20);
  assert.equal(result.invalid_frames_rejected, 3);
});

test('cam2qr scanner reads event QR fixtures and rejects unrelated and invalid frames', async () => {
  require('../scripts/build-cam2qr.cjs')(path.join(__dirname, '../robot/vendor'));
  const { default: Decoder } = await import('../robot/qr-decoder.js');
  const { makeFrame } = await import('./qr-runtime-check.mjs');
  const decoder = new Decoder();
  const items = [...fixtures(), fixture('real-ticket-token', 'SC1:ScyLk__NVL7gel3oPNGLCg')];
  for (const scale of [2, 3, 4]) for (const rotated of [false, true])
    items.push(fixture(`small-${scale}-${rotated}`, undefined, { width: 160, height: 120, scale, rotated }));
  // A short code far from the camera: 1.5 camera pixels per QR module needs full-resolution decoding.
  const far = fixture('far-short-token', 'SC1:Ab3_-zQ9xK', { width: 160, height: 120, scale: 1.5 });
  items.push(far);
  const frames = items.map(item => [item, makeFrame(item)]);
  // Like the robot's XS runtime: no TextEncoder/TextDecoder. Uppercase/numeric tokens produce non-byte segments.
  const saved = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
  delete globalThis.TextEncoder; delete globalThis.TextDecoder;
  try {
    for (const [item, frame] of frames) assert.equal(decoder.decode(frame), item.payload, item.name);
  } finally { Object.assign(globalThis, saved); }
  const { default: decode } = await import('../robot/vendor/cam2qr.js');
  const halfResolution = decode({ data: new Uint8Array(makeFrame(far).buffer), width: 80, height: 60, step: 2 }, { tryInverted: false });
  assert.equal(halfResolution, null, 'the far code is unreadable at the old 80x60 resolution');
  const frame = makeFrame(fixtures()[0]);
  assert.throws(() => decoder.decode({ ...frame, buffer: new ArrayBuffer(1) }));
});

test('cam2qr errors can be created when Error.prototype is frozen', () => {
  const moduleURL = pathToFileURL(path.join(__dirname, '../robot/vendor/cam2qr.js')).href;
  const script = `Object.freeze(Error.prototype); const {DecodeError}=await import(${JSON.stringify(moduleURL)}); const error=new DecodeError('bad','test'); if(error.message!=='test' || error.code!=='bad') process.exit(1);`;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', script]));
});

test('a stranger\'s Kanji QR, even one starting with a valid-looking code, is ignored rather than failing the scan', async () => {
  const QRCode = require('qrcode');
  const toSJISFunc = require('qrcode/helper/to-sjis');
  const token = 'SC1:abcdefghijklmnopqrstuv';
  const matrix = QRCode.create([{ data: token, mode: 'byte' }, { data: '漢字', mode: 'kanji' }],
    { errorCorrectionLevel: 'M', toSJISFunc }).modules;
  const { makeFrame } = await import('./qr-runtime-check.mjs');
  const frame = makeFrame({ width: 320, height: 240, scale: 5, matrix: { size: matrix.size, data: Array.from(matrix.data) } });
  const { default: Decoder } = await import('../robot/qr-decoder.js');
  assert.equal(new Decoder().decode(frame), undefined);
});

async function harness({ writing = true, mismatchedReadback = false, failAck = false, actualQR = false, failingWrites = 0 } = {}) {
  const { EventController } = await import('../robot/controller.js');
  let offset = 0; // backend clock skew, to let a reservation expire
  const store = new Store(null, { now: () => Date.now() + offset });
  const item = await store.create({ sid: 'SM_COMMUNITY_TEST', from: '+15555550123', body: 'https://example.com/profile' });
  const functions = createFunctions({ store, baseURL: 'http://mock.example' });
  const { default: Decoder } = await import('../robot/qr-decoder.js');
  const { makeFrame } = await import('./qr-runtime-check.mjs');
  const decoder = new Decoder();
  const pixels = actualQR ? makeFrame(fixture('live-claim', 'SC1:' + item.token)) : undefined;
  const events = [], messages = [], timers = new Map();
  let timerId = 0, saved, writes = 0, readerCreations = 0, frameCloses = 0, ackFails = failAck;
  // The card currently in the reader's RF field, if any.
  let field;
  const controller = new EventController({
    station: 'community-01', enableNFCWrite: writing,
    camera: { available: true,
      start: async () => events.push('camera.start'),
      stop: async () => events.push('camera.stop'),
      capture: async () => ({ ...(pixels || { width: 320, height: 240, imageType: 'rgb565le', buffer: new ArrayBuffer(4) }),
        close() { frameCloses++; events.push('frame.close'); } }),
    },
    decode: frame => actualQR ? decoder.decode(frame) : 'SC1:' + item.token,
    post: async (route, event) => {
      events.push(route);
      if (route === '/api/complete' && ackFails) throw new Error('offline');
      return (await (route === '/api/claim' ? functions.claim(event) : functions.complete(event))).body;
    },
    makeReader: () => {
      readerCreations++; events.push('reader.create');
      const records = () => field?.uri ? [{ tnf: 1, type: 'U', uri: field.uri }] : [];
      return {
        configure({ antenna }) { events.push('field:' + (antenna ? 'on' : 'off')); },
        inspect: () => field && { sak: field.sak, uidHex: field.uidHex, formatted: field.formatted, writable: field.writable,
          capacity: 144, ndef: field.formatted ? { records: records() } : undefined },
        sample: () => field ? { present: true, sak: field.sak, uidHex: field.uidHex } : undefined,
        writeNDEF({ uri }) { writes++; assert.equal(uri, item.url); if (failingWrites-- > 0) throw new Error('writePage failed'); field.uri = mismatchedReadback ? 'https://wrong.example' : uri; },
        readNDEF: () => ({ records: records() }),
        close: () => events.push('reader.close'),
      };
    },
    schedule: fn => { const id = ++timerId; timers.set(id, fn); return id; }, cancel: id => timers.delete(id),
    receipt: { load: () => saved, save: value => { saved = value; }, clear: () => { saved = undefined; } },
    report(state, text) { messages.push({ state, text }); },
    checkpoint(step) { events.push('step:' + step); },
  });
  return { controller, item, store, events, messages, timers,
    get writes() { return writes; }, get readers() { return readerCreations; }, get frameCloses() { return frameCloses; },
    get receipt() { return saved; }, restoreNetwork: () => { ackFails = false; }, advance: ms => { offset += ms; },
    place({ sak = 0, writable = true, formatted = true, uri } = {}) { field = { sak, writable, formatted, uri, uidHex: '04aabbccddeeff' }; },
    remove() { field = undefined; },
    async tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); },
    async until(predicate, limit = 20) { while (!predicate()) { if (!limit--) throw new Error('condition not reached'); await this.tick(); } },
  };
}
test('community MOD stops camera before NFC and completes only after verified URL read-back', async () => {
  const h = await harness({ actualQR: true });
  await h.controller.start(); await h.tick();
  assert.equal(h.controller.state, 'awaiting_card');
  assert.equal(h.messages.at(-1).text, 'Tap your NFC card!', 'started by a head pat: no card was checked');
  assert.equal(h.frameCloses, 1);
  assert.ok(h.events.indexOf('frame.close') < h.events.lastIndexOf('camera.stop'));
  assert.ok(h.events.lastIndexOf('camera.stop') < h.events.indexOf('reader.create'));
  h.place();
  await h.tick();
  assert.equal(h.controller.state, 'awaiting_card', 'waits for the card to rest before writing');
  assert.equal(h.writes, 0);
  await h.tick();
  assert.equal(h.controller.state, 'done');
  assert.equal(h.messages.at(-1).text, "Yay! Card #1 today!");
  assert.deepEqual(h.events.filter(e => e.startsWith('step:') || e === 'reader.create'),
    ['step:claim reply received', 'step:loading NFC reader', 'reader.create', 'step:turning on NFC field']);
  assert.equal(h.writes, 1);
  assert.equal((await h.store.get(h.item.token)).status, 'complete');
  assert.equal(h.receipt, undefined);
  assert.equal(h.events.at(-1 - h.events.slice().reverse().findIndex(e => e.startsWith('field:'))), 'field:off', 'RF field off after the write');
});
test('a tapped card shows its link without claiming; left on the reader, it is written right after the QR', async () => {
  const h = await harness();
  h.controller.watch();
  await h.tick();
  assert.equal(h.controller.state, 'watching', 'an empty field keeps watching');
  assert.equal(h.timers.size, 1);
  h.place({ uri: 'https://www.old.example/page' });
  await h.tick();
  assert.deepEqual(h.messages.at(-1), { state: 'card_checked', text: 'old.example/page' });
  assert.equal(h.timers.size, 0, 'watching stops once a card is checked');
  assert.ok(!h.events.includes('/api/claim'));
  await h.controller.start(); await h.tick();
  assert.ok(!h.messages.some(m => m.state === 'awaiting_card'), 'no second tap needed');
  assert.equal(h.controller.state, 'done');
  assert.equal(h.writes, 1);
});
test('an empty card says so; removed during the QR scan, the guest is asked to tap it again', async () => {
  const h = await harness();
  h.place();
  h.controller.watch(); await h.tick();
  assert.deepEqual(h.messages.at(-1), { state: 'card_checked', text: 'Empty card!' });
  h.remove();
  await h.controller.start(); await h.tick();
  assert.deepEqual(h.messages.at(-1), { state: 'awaiting_card', text: 'Tap your card again!' });
  h.place();
  await h.until(() => h.controller.state === 'done');
});
test('unusable and locked cards are turned away before any QR or claim', async () => {
  for (const [card, text] of [[{ sak: 0x08 }, "I can't use that card."], [{ formatted: false }, "I can't use that card."], [{ writable: false }, 'That card is locked.']]) {
    const h = await harness();
    h.place(card);
    h.controller.watch(); await h.tick();
    assert.deepEqual(h.messages.at(-1), { state: 'card_rejected', text });
    assert.ok(!h.events.includes('camera.start') && !h.events.includes('/api/claim'));
    h.controller.watch();
    assert.equal(h.controller.state, 'watching', 'watching resumes after a rejected card');
  }
});
test('unwatch and stop end card polling, switch the field off, and release the reader', async () => {
  const h = await harness();
  h.controller.watch(); await h.tick();
  h.controller.unwatch();
  assert.deepEqual([h.controller.state, h.timers.size, h.events.at(-1)], ['idle', 0, 'field:off']);
  h.controller.watch(); await h.controller.stop();
  assert.equal(h.timers.size, 0);
  assert.ok(h.events.includes('reader.close'));
  const scanner = await harness({ writing: false });
  scanner.controller.watch();
  assert.equal(scanner.timers.size, 0, 'no card watch when NFC writing is off');
});
test('scanner-only setting never enables NFC; read-back mismatch never completes', async () => {
  const scan = await harness({ writing: false });
  await scan.controller.start(); await scan.tick();
  assert.equal(scan.controller.state, 'claimed'); assert.equal(scan.readers, 0);
  const write = await harness({ mismatchedReadback: true });
  await write.controller.start(); await write.tick(); write.place();
  await write.until(() => write.messages.at(-1).text === 'Hold it still and tap again!');
  assert.equal(write.writes, 3, 'three attempts before asking for another tap');
  assert.equal((await write.store.get(write.item.token)).status, 'reserved');
  assert.ok(!write.events.includes('/api/complete'));
});
test('a failed page write is retried on the spot, then by another tap, without showing the QR again', async () => {
  const once = await harness({ failingWrites: 1 });
  once.place();
  await once.controller.start(); await once.tick();
  assert.equal(once.controller.state, 'writing', 'first attempt failed; retry scheduled');
  await once.tick();
  assert.equal(once.controller.state, 'done', 'second attempt succeeds while the card is held');
  assert.equal(once.writes, 2);
  const flaky = await harness({ failingWrites: 3 });
  await flaky.controller.start(); await flaky.tick();
  flaky.place();
  await flaky.until(() => flaky.messages.at(-1).text === 'Hold it still and tap again!');
  assert.equal(flaky.writes, 3);
  await flaky.until(() => flaky.controller.state === 'done');
  assert.equal(flaky.events.filter(e => e === '/api/claim').length, 1, 'one claim: no second QR scan');
  assert.equal(flaky.events.filter(e => e === 'reader.create').length, 1, 'a fresh reader after the claim');
});
test('lost completion response retries acknowledgement without a second card write', async () => {
  const h = await harness({ failAck: true });
  await h.controller.start(); await h.tick(); h.place();
  await h.until(() => h.controller.state === 'pending_ack'); assert.ok(h.receipt);
  h.restoreNetwork(); await h.controller.start();
  assert.equal(h.controller.state, 'done'); assert.equal(h.writes, 1);
});
test('a completion the backend refuses for good is dropped, not retried on every tap', async () => {
  const h = await harness({ failAck: true });
  await h.controller.start(); await h.tick(); h.place();
  await h.until(() => h.controller.state === 'pending_ack'); assert.ok(h.receipt);
  // Offline past the 2-minute reservation: the backend answers 409 "Reservation expired." from now on.
  h.advance(3 * 60000); h.restoreNetwork(); await h.controller.start();
  assert.equal(h.controller.state, 'done');
  assert.equal(h.messages.at(-1).text, 'Yay! Your card is ready!');
  assert.equal(h.receipt, undefined);
  await h.controller.start();
  assert.equal(h.controller.state, 'scanning', 'the next tap serves the next guest');
  assert.equal(h.events.filter(e => e === '/api/complete').length, 2);
  assert.equal(h.writes, 1);
});
