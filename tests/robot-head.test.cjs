const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = async () => (await import(pathToFileURL(path.resolve(__dirname, '../robot/look-around.js')).href)).LookAround;
const settle = () => new Promise(resolve => setImmediate(resolve));

function rig({ torqueError } = {}) {
  const calls = [], timers = new Map();
  let next = 0, release;
  const motion = {
    lookAt(point) { calls.push(['lookAt', point]); }, lookAway() { calls.push(['lookAway']); },
    async setPose(pose, time) { calls.push(['setPose', pose.rotation.y, pose.rotation.p, time]); },
    setTorque(on) {
      calls.push(['torque', on]);
      if (torqueError) return Promise.reject(torqueError);
      return on ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
    },
  };
  return { calls, timers, motion, release: () => release?.(),
    schedule: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, cancel: id => timers.delete(id),
    fire() { const [id, { fn }] = timers.entries().next().value; timers.delete(id); fn(); } };
}
const names = calls => calls.map(([name]) => name);

test('look around glances left and right every 4-7 s, faces the aisle every fourth, and reports each glance', async () => {
  const LookAround = await load(), r = rig(), glances = [];
  const look = new LookAround({ ...r, random: () => 0.5, onGlance: ahead => glances.push(ahead) });
  const resumed = look.resume(); void look.resume();
  r.release(); await resumed;
  assert.deepEqual(names(r.calls), ['lookAway', 'torque', 'setPose']);
  assert.deepEqual([...r.timers.values()].map(timer => timer.ms), [5500]);
  r.fire(); r.fire(); r.fire();
  const poses = r.calls.filter(([name]) => name === 'setPose');
  assert.deepEqual(poses.map(([, y]) => Math.sign(y)), [-1, 1, -1, 0]);
  assert.ok(poses.every(([, y, p, time]) => Math.abs(y) <= 0.5 && p >= -0.15 && p <= 0.03 && time === 1), 'small, slow glances');
  assert.deepEqual(glances, [false, false, false, true]);
  assert.equal(r.timers.size, 1, 'the next glance is scheduled');
});

test('pause faces forward once; a pause during torque start-up wins over the pending resume', async () => {
  const LookAround = await load(), r = rig();
  const look = new LookAround(r);
  const resumed = look.resume();
  const paused = look.pause();
  r.release(); await resumed; await paused;
  assert.deepEqual(r.calls.filter(([name]) => name === 'setPose'), [['setPose', 0, 0, 0.5]], 'no glance, one forward move');
  assert.equal(r.timers.size, 0);
  await look.pause();
  assert.equal(names(r.calls).filter(name => name === 'setPose').length, 1, 'holding forward issues one move');
});

test('nod makes two small moves from the forward hold, and stops if the head is taken over', async () => {
  const LookAround = await load(), r = rig();
  const look = new LookAround(r);
  assert.equal(await look.nod(), false, 'no nod unless holding forward');
  const paused = look.pause(); r.release(); await paused;
  assert.equal(await look.nod(), true);
  assert.deepEqual(r.calls.filter(([name]) => name === 'setPose').slice(1).map(([, y, p, time]) => [y, p, time]), [[0, -0.12, 0.2], [0, 0, 0.2], [0, -0.12, 0.2], [0, 0, 0.2]]);
  const nodding = look.nod(); await look.rest();
  assert.equal(await nodding, false);
});

test('rest and close switch the servos off; a later pause re-enables torque and faces forward', async () => {
  const LookAround = await load(), r = rig();
  const look = new LookAround(r);
  const resumed = look.resume(); r.release(); await resumed;
  await look.rest();
  assert.deepEqual(r.calls.at(-1), ['torque', false]);
  assert.equal(r.timers.size, 0);
  const paused = look.pause(); await settle(); r.release(); await paused;
  assert.deepEqual(r.calls.slice(-2), [['torque', true], ['setPose', 0, 0, 0.5]]);
  await look.close();
  assert.deepEqual(r.calls.at(-1), ['torque', false]);
  await look.resume();
  assert.equal(r.timers.size, 0, 'a closed look-around never restarts');
});

test('a torque failure is logged, not thrown', async () => {
  const LookAround = await load(), errors = [], r = rig({ torqueError: new Error('servo bus') });
  await new LookAround({ ...r, log: error => errors.push(error.message) }).resume();
  assert.deepEqual(errors, ['servo bus']);
  assert.equal(r.timers.size, 0);
});
