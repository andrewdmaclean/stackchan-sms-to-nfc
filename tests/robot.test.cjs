const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const INVITE = 'Pat my head to start!';
const TAP = { kind: 'touch-panel', gesture: 'release', tap: { durationMs: 120 } };

async function fixture(t, { importError, motion = false,
  receipt, reply = { status: 'complete' }, fontMissing = false, interruptedStep, nfc = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stackchan-qr-startup-'));
  const key = `qrStartup_${path.basename(directory).replaceAll('-', '_')}`;
  const buttons = new Map(), timers = new Map(), messages = [], balloonOptions = [], traces = [];
  const moves = [], faces = [], colors = [], hands = [], lights = [], posts = [];
  let field; // card in the fake NFC reader's field
  const mains = []; // what fills the screen: 'qr' or 'face'
  let imports = 0, starts = 0, stops = 0, opens = 0, closes = 0, nextTimer = 0, clock = 0, headListener;
  const preferences = { receipt: receipt && JSON.stringify(receipt), step: interruptedStep };
  const previous = { trace: globalThis.trace, device: globalThis.device, fromString: ArrayBuffer.fromString, fromArrayBuffer: String.fromArrayBuffer };
  globalThis.trace = text => traces.push(text);
  // Moddable string/buffer helpers and an ECMA-419 HTTP client that answers every POST with `reply`.
  ArrayBuffer.fromString ??= text => new TextEncoder().encode(text).buffer;
  String.fromArrayBuffer ??= buffer => new TextDecoder().decode(buffer);
  globalThis.device = { sensor: nfc ? { RFID: {} } : {}, i2c: { internal: {} }, io: { SMBus: class {} }, network: { http: { client: { io: class {
    request(request) {
      posts.push(request.path);
      const body = new TextEncoder().encode(JSON.stringify(reply));
      const io = { write() {}, read: () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
      queueMicrotask(() => { request.onHeaders.call(io, 200); request.onWritable.call(io, 4096); request.onReadable.call(io, body.byteLength); request.onDone.call(io); });
    }
    close() {}
  } } } } };
  globalThis[key] = {
    config: { enableNFCWrite: nfc, station: 'test', host: '127.0.0.1', port: 8791, token: 'test' },
    preference: { get: (domain, name) => preferences[name], set(domain, name, value) { preferences[name] = value; }, delete(domain, name) { delete preferences[name]; } },
    // A fake clock: tick() runs the timer due soonest.
    timer: { set(callback, ms = 0) { const id = ++nextTimer; timers.set(id, { callback, due: clock + ms }); return id; }, clear(id) { timers.delete(id); } },
    modules: { importNow(name) {
      if (name === 'text-me-screen') return ({ caption, font }) => ({ view: 'text-me-qr', caption, font });
      if (name === 'vendor/st25r3916') return class {
        configure() {} close() {}
        inspect() { return field && { sak: 0, uidHex: '04AA', formatted: true, writable: true, capacity: 144,
          ndef: { records: field.uri ? [{ tnf: 1, type: 'U', uri: field.uri }] : [] } }; }
        sample() { return field && { present: true, sak: 0, uidHex: '04AA' }; }
      };
      assert.equal(name, 'qr-decoder'); imports++;
      if (importError) throw importError;
      return class { decode() { return 'SC1:abcdefghijklmnopqrstuv'; } close() {} };
    } },
  };
  for (const [name, property] of [['timer', 'timer'], ['modules', 'modules'], ['event-config', 'config'], ['preference', 'preference']]) {
    const packageDirectory = path.join(directory, 'node_modules', name);
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
    fs.writeFileSync(path.join(packageDirectory, 'index.js'), `export default globalThis[${JSON.stringify(key)}].${property};`);
  }
  const source = path.join(__dirname, '../robot');
  // The MOD's bare `vendor/...` module names, served from the real vendored files.
  const vendorDirectory = path.join(directory, 'node_modules', 'vendor');
  fs.mkdirSync(vendorDirectory, { recursive: true });
  fs.writeFileSync(path.join(vendorDirectory, 'package.json'), JSON.stringify({ type: 'module', exports: { './amazon-root-ca1': './amazon-root-ca1.js' } }));
  fs.copyFileSync(path.join(source, 'vendor/amazon-root-ca1.js'), path.join(vendorDirectory, 'amazon-root-ca1.js'));
  {
    // Stage relative modules beside the fixture so its platform imports use
    // the fake packages. Only relative import locations change for Node.
    const code = fs.readFileSync(path.join(source, 'mod.js'), 'utf8')
      .replace("from './controller'", "from './controller.mjs'")
      .replace("from './http'", "from './http.mjs'")
      .replace("from './look-around'", "from './look-around.mjs'");
    fs.writeFileSync(path.join(directory, 'mod.mjs'), code);
    for (const name of ['controller', 'http', 'look-around']) fs.copyFileSync(path.join(source, name + '.js'), path.join(directory, name + '.mjs'));
  }
  t.after(() => {
    Object.assign(globalThis, { trace: previous.trace, device: previous.device });
    ArrayBuffer.fromString = previous.fromString; String.fromArrayBuffer = previous.fromArrayBuffer;
    delete globalThis[key]; fs.rmSync(directory, { recursive: true, force: true });
  });
  const { onContextCreated } = await import(pathToFileURL(path.join(directory, 'mod.mjs')));
  onContextCreated({
    camera: { available: true, async start() { starts++; }, async stop() { stops++; },
      async capture() { return { width: 320, height: 240, close() {} }; } },
    ui: { showBalloon(message, options) { if (fontMissing && options?.font) throw new Error('font not found'); messages.push(message); balloonOptions.push(options); },
      setHandAnimation(name) { hands.push(name); },
      setMain(content) { mains.push(content.view === 'text-me-qr' ? 'qr' : 'other'); }, showFace() { mains.push('face'); }, hideBalloon() {}, openDrawer() { opens++; }, closeDrawer() { closes++; },
      drawer: { addDrawerButton(button) { buttons.set(button.key, button); }, removeDrawerButton(key) { buttons.delete(key); } } },
    face: { setEmotion(emotion) { faces.push(emotion); }, setColor(...color) { colors.push(color); } },
    lighting: { led: { head: {} }, lightRainbow(name) { lights.push(`rainbow:${name}`); }, lightOff(name) { lights.push(`off:${name}`); } },
    input: { touchPanel: { subscribe(listener) { headListener = listener; return () => { headListener = undefined; }; } } },
    ...(motion ? { motion: { lookAt() { moves.push('lookAt'); }, lookAway() { moves.push('lookAway'); },
      async setPose(pose) { moves.push(`pose:${pose.rotation.y},${pose.rotation.p}`); }, async setTorque(on) { moves.push(`torque:${on}`); } } } : {}),
  });
  return { buttons, messages, balloonOptions, traces, moves, mains, faces, colors, hands, lights, posts,
    get imports() { return imports; }, get starts() { return starts; }, get stops() { return stops; }, get opens() { return opens; },
    get closes() { return closes; }, get timerCount() { return timers.size; }, get receipt() { return preferences.receipt; }, preferences,
    pat(event = TAP) { headListener?.(event); },
    place(card = {}) { field = card; },
    async tick() {
      let next;
      for (const entry of timers) if (!next || entry[1].due < next[1].due) next = entry;
      timers.delete(next[0]); clock = next[1].due; await next[1].callback();
    },
    async until(predicate, limit = 100) { while (!predicate()) { if (!limit--) throw new Error('condition not reached'); await this.tick(); await settle(); } },
  };
}

test('the first scan loads the cam2qr decoder, then starts the camera', async t => {
  const f = await fixture(t, { event: true });
  f.buttons.get('event-scan').callback();
  await f.tick(); await f.tick(); await f.tick(); await settle();
  assert.equal(f.imports, 1); assert.equal(f.starts, 1);
  assert.equal(f.messages.at(-1), 'Show me your QR code!');
});

test('event boots Twilio red with a big-font invitation; only a head tap or stroke starts one scan', async t => {
  const f = await fixture(t, { event: true });
  assert.deepEqual(f.colors.slice(0, 2), [['primary', 0xff, 0xff, 0xff], ['secondary', 0xef, 0x22, 0x3a]], 'secondary is the face background');
  assert.deepEqual(f.colors.slice(-2), [['primary', 0xff, 0xff, 0xff], ['secondary', 0xef, 0x22, 0x3a]], 'waiting: red theme');
  assert.deepEqual([f.messages[0], f.balloonOptions[0]], [INVITE, { font: '24px Open Sans' }]);
  assert.equal(f.opens, 0, 'the drawer stays closed so the face is visible');
  f.pat({ kind: 'touch-panel', gesture: 'press' });
  assert.equal(f.messages.at(-1), INVITE);
  f.pat();
  assert.equal(f.messages.at(-1), 'Checking saved card...');
  f.pat({ kind: 'touch-panel', gesture: 'forwardSwipe' });
  assert.equal(f.closes, 1, 'a second pat while starting must not create another scan');
  await f.tick();
  assert.equal(f.messages.at(-1), 'Loading QR decoder...');
});

test('balloon text falls back to the default font when the host lacks Open Sans 24', async t => {
  const f = await fixture(t, { event: true, fontMissing: true });
  assert.deepEqual([f.messages[0], f.balloonOptions[0]], [INVITE, undefined]);
  assert.ok(f.traces.some(line => line.includes('24px Open Sans unavailable')));
});

test('event Scan / retry displays each startup stage before decoder loading and camera startup', async t => {
  const f = await fixture(t, { event: true });
  f.buttons.get('event-scan').callback();
  assert.equal(f.closes, 1);
  assert.equal(f.messages.at(-1), 'Checking saved card...');
  assert.equal(f.imports, 0); assert.equal(f.starts, 0);
  f.buttons.get('event-scan').callback();
  assert.equal(f.closes, 1, 'a second tap while starting must not create another scan');
  await f.tick();
  assert.equal(f.messages.at(-1), 'Loading QR decoder...');
  assert.equal(f.imports, 0); assert.equal(f.starts, 0);
  await f.tick();
  assert.equal(f.messages.at(-1), 'Starting camera...');
  assert.equal(f.imports, 1); assert.equal(f.starts, 0);
  await f.tick(); await settle();
  assert.equal(f.imports, 1); assert.equal(f.starts, 1);
  assert.equal(f.messages.at(-1), 'Show me your QR code!');
});

test('Stop event cancels a pending startup stage and invites the next guest', async t => {
  const f = await fixture(t, { event: true });
  f.pat();
  await f.buttons.get('event-stop').callback();
  assert.equal(f.messages.at(-1), 'Stopped');
  await f.tick();
  assert.equal(f.messages.at(-1), INVITE);
  assert.equal(f.starts, 0); assert.equal(f.imports, 0);
});

test('event looks around while waiting, faces forward to scan, and resumes after Stop', async t => {
  const f = await fixture(t, { event: true, motion: true });
  await settle();
  assert.deepEqual(f.moves.slice(0, 2), ['lookAway', 'torque:true']);
  assert.ok([f.moves[2]].every(move => /^pose:-?0\.\d+,/.test(move) && !move.startsWith('pose:0,')), 'a side glance right away');
  assert.equal(f.moves.length, 3);
  f.pat(); await settle();
  assert.deepEqual(f.moves.slice(3), ['lookAway', 'pose:0,0']);
  await f.tick(); await f.tick(); await f.tick(); await settle();
  assert.equal(f.messages.at(-1), 'Show me your QR code!');
  assert.ok(!f.moves.slice(5).some(move => move === 'lookAt' || move.startsWith('pose:')), 'no head moves while the camera is aimed at the guest');
  await f.buttons.get('event-stop').callback(); await settle();
  assert.ok([f.moves.at(-1)].every(move => /^pose:-?0\.\d+,/.test(move) && !move.startsWith('pose:0,')), 'glances again after Stop');
});

test('an idle robot naps with servos off, then a head pat wakes it straight into a scan', async t => {
  const f = await fixture(t, { event: true, motion: true });
  await f.until(() => f.messages.at(-1) === 'Zzz... pat my head!');
  assert.equal(f.faces.at(-1), 4, 'sleepy face');
  assert.equal(f.moves.at(-1), 'torque:false');
  const napMoves = f.moves.length;
  for (let i = 0; i < 6; i++) await f.tick(); // the face/QR swap keeps cycling while napping
  assert.ok(f.mains.includes('qr'), 'the text-me QR still shows during a nap');
  assert.deepEqual(f.moves.slice(napMoves), [], 'servos stay off while napping');
  f.pat(); await settle();
  assert.deepEqual(f.moves.slice(-3), ['lookAway', 'torque:true', 'pose:0,0']);
  assert.equal(f.messages.at(-1), 'Checking saved card...');
});

test('without head motion the celebration still runs: face, clapping, rainbow and the card number', async t => {
  const f = await fixture(t, { event: true, reply: { status: 'complete', card: 3 },
    receipt: { token: 'Ab3_-zQ9xK', station: 'test', lease_id: 'l', verified: true, uid: '04AABBCCDD' } });
  f.pat();
  await f.until(() => f.messages.includes("Yay! Card #3 today!"));
  await settle();
  assert.deepEqual([f.faces.at(-1), f.hands.at(-1), f.lights.at(-1)], [3, 'clap', 'rainbow:head']);
  assert.ok(!f.traces.some(line => /TypeError|start failed/.test(line)));
});

test('a numbered card gets a happy face, clapping, a rainbow and a nod, then the robot invites the next guest', async t => {
  const f = await fixture(t, { event: true, motion: true, reply: { status: 'complete', card: 7 },
    receipt: { token: 'abcdefghijklmnopqrstuv', station: 'test', lease_id: 'lease', verified: true, uid: '04AABBCCDDEEFF' } });
  f.pat();
  await f.until(() => f.messages.includes("Yay! Card #7 today!"));
  assert.deepEqual(f.posts, ['/api/complete']);
  assert.equal(f.receipt, undefined);
  assert.equal(f.faces.at(-1), 3, 'happy face');
  assert.equal(f.hands.at(-1), 'clap');
  assert.equal(f.lights.at(-1), 'rainbow:head');
  await settle();
  assert.deepEqual(f.moves.filter(move => move.startsWith('pose:')).slice(-5, -1), ['pose:0,-0.12', 'pose:0,0', 'pose:0,-0.12', 'pose:0,0']);
  assert.ok([f.moves.at(-1)].every(move => /^pose:-?0\.\d+,/.test(move) && !move.startsWith('pose:0,')), 'looks around again after the celebration');
  assert.equal(f.faces.at(-1), 3, 'idle glances do not replace the celebration face');
  await f.until(() => f.lights.at(-1) === 'off:head');
  assert.equal(f.hands.at(-1), 'none');
  await f.until(() => f.messages.at(-1) === INVITE);
});

test('while waiting, glances change the face and a look at the aisle smiles; scanning stops both', async t => {
  const f = await fixture(t, { event: true, motion: true });
  await settle();
  const faceChanges = f.faces.length;
  await f.until(() => f.moves.some(move => move.startsWith('pose:0,') && move !== 'pose:0,0'));
  assert.ok(f.faces.length > faceChanges, 'glances change the expression');
  assert.equal(f.faces.at(-1), 3, 'facing the aisle is a smile');
  f.pat(); await settle();
  const scanning = f.faces.length;
  await f.tick(); await f.tick(); await f.tick(); await settle();
  assert.deepEqual([...new Set(f.faces.slice(scanning))], [0], 'only the steady scanning face; no idle expressions');
  assert.equal(f.messages.at(-1), 'Show me your QR code!');
});

test('a reset mid-guest is reported on the next boot, and network/NFC steps run with the servos off', async t => {
  const f = await fixture(t, { event: true, motion: true, interruptedStep: 'turning on NFC field',
    reply: { status: 'complete', card: 2 }, receipt: { token: 'Ab3_-zQ9xK', station: 'test', lease_id: 'l', verified: true, uid: '04AABBCCDD' } });
  assert.equal(f.messages.at(-1), 'Reset at: turning on NFC...', 'balloons are capped at 28 characters');
  assert.ok(f.traces.some(line => line.includes('balloon shortened: Reset at: turning on NFC field')), 'the full text is logged');
  assert.ok(f.messages.every(message => message.length <= 28));
  assert.equal(f.preferences.step, undefined, 'the report is shown once');
  assert.ok(f.traces.some(line => line.includes('previous run reset during: turning on NFC field')));
  f.pat();
  await f.until(() => f.messages.includes('Card written! Saving...'));
  assert.equal(f.preferences.step, undefined, 'finished guests leave no step behind');
  const saving = f.moves.lastIndexOf('torque:false');
  assert.ok(saving > f.moves.indexOf('pose:0,0'), 'servos switch off for the network step after facing forward');
  await f.until(() => f.messages.includes("Yay! Card #2 today!"));
  await settle();
  assert.deepEqual(f.moves.slice(saving + 1, saving + 3), ['lookAway', 'torque:true'], 'servos come back on for the celebration');
});

test('card first: a tap shows what the card holds, then the robot faces forward and asks for the QR', async t => {
  const f = await fixture(t, { event: true, nfc: true, motion: true });
  assert.equal(f.messages[0], 'Tap your card on me!');
  await f.tick(); await settle();
  f.place({ uri: 'https://example.com/old' });
  await f.until(() => f.messages.includes('example.com/old'));
  assert.equal(f.faces.at(-1), 3, 'happy to see a card');
  await f.until(() => f.messages.at(-1) === 'Show me your QR code!');
  assert.equal(f.starts, 1, 'camera started after the card check');
  assert.ok(f.moves.includes('pose:0,0'), 'facing forward for the camera');
});

test('card first: napping still answers a card tap', async t => {
  const f = await fixture(t, { event: true, nfc: true });
  await f.until(() => f.messages.at(-1) === 'Zzz... tap your card!', 1000); // ~360 card checks in 3 minutes
  f.place();
  await f.until(() => f.messages.includes('Empty card!'));
  await f.until(() => f.messages.at(-1) === 'Show me your QR code!');
});

test('while waiting, the face alternates with a text-me QR; a card tap brings the face straight back', async t => {
  const f = await fixture(t, { event: true, nfc: true, motion: true });
  await f.until(() => f.mains.at(-1) === 'qr');
  assert.ok(f.moves.includes('pose:0,0'), 'the head holds still while the QR is up');
  await f.until(() => f.mains.at(-1) === 'face');
  assert.equal(f.messages.at(-1), 'Tap your card on me!');
  await f.until(() => f.mains.at(-1) === 'qr');
  f.place();
  await f.until(() => f.messages.includes('Empty card!'));
  assert.equal(f.mains.at(-1), 'face');
  await f.until(() => f.messages.at(-1) === 'Show me your QR code!');
  const scanning = f.mains.length;
  for (let i = 0; i < 20; i++) await f.tick();
  assert.equal(f.mains.length, scanning, 'no QR swaps during the scan');
});

test('the face switches Twilio brand themes with the mode', async t => {
  const hex = c => c.slice(1).map(v => v.toString(16).padStart(2, '0')).join('');
  const theme = f => [f.colors.filter(([key]) => key === 'secondary').at(-1), f.colors.filter(([key]) => key === 'primary').at(-1)].map(hex).join('/');
  const f = await fixture(t, { event: true, nfc: true, reply: { status: 'complete', card: 5 },
    receipt: { token: 'Ab3_-zQ9xK', station: 'test', lease_id: 'l', verified: true, uid: '04AABBCCDD' } });
  assert.equal(theme(f), 'ef223a/ffffff', 'waiting: red theme');
  f.place();
  await f.until(() => f.messages.includes('Empty card!'));
  assert.equal(theme(f), '000d25/ffffff', 'card checked: dark theme');
  await f.until(() => f.messages.includes('Yay! Card #5 today!'));
  assert.equal(theme(f), 'ef223a/ffffff', 'done: red theme');
  const napping = await fixture(t, { event: true });
  await napping.until(() => napping.messages.at(-1) === 'Zzz... pat my head!');
  assert.equal(theme(napping), '000d25/ffffff', 'napping: dark theme');
  const { readFileSync } = require('node:fs');
  const source = readFileSync(path.join(__dirname, '../robot/mod.js'), 'utf8') + readFileSync(path.join(__dirname, '../robot/text-me-screen.js'), 'utf8');
  const colours = new Set([...source.matchAll(/0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0x([0-9a-f]{2})|#([0-9A-Fa-f]{6})/g)].map(m => (m[4] || m[1] + m[2] + m[3]).toLowerCase()));
  assert.deepEqual([...colours].sort(), ['000d25', 'ef223a', 'ffffff'], 'only Twilio Red, Ink and White');
});
