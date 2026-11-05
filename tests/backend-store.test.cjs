const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, validURL } = require('../backend/store.cjs');
const { MockSyncService } = require('../backend/mock-sync.cjs');
const { createFunctions } = require('../backend/handlers.cjs');

const message = { sid: 'SM123', from: '+16045550123', body: 'https://example.com/profile' };
test('Sync mock enforces revisions, JSON isolation, TTL and unique keys', async () => {
  let now = 1000;
  const sync = new MockSyncService(null, { now: () => now });
  const items = sync.syncMaps('test_items').syncMapItems;
  const first = await items.create({ key: 'one', data: { count: 1 }, ttl: 10 });
  first.data.count = 99;
  assert.equal((await items('one').fetch()).data.count, 1);
  await assert.rejects(items.create({ key: 'one', data: {} }), { status: 409 });
  const next = await items('one').update({ data: { count: 2 }, ifMatch: first.revision });
  assert.notEqual(next.revision, first.revision);
  await assert.rejects(items('one').update({ data: {}, ifMatch: first.revision }), { status: 412 });
  assert.equal(next.dateExpires, first.dateExpires);
  now += 10001;
  await assert.rejects(items('one').fetch(), { status: 404 });
});
test('independent handlers sharing Sync resolve simultaneous deliveries and competing claims', async () => {
  const sync = new MockSyncService();
  const a = new Store(null, { sync }), b = new Store(null, { sync });
  const submissions = await Promise.all([a.create(message), b.create(message)]);
  assert.equal(submissions[0].token, submissions[1].token);
  const { token } = submissions[0];
  const claims = await Promise.allSettled([a.claim(token, 'station-a'), b.claim(token, 'station-b')]);
  assert.equal(claims.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(claims.find(x => x.status === 'rejected').reason.status, 409);
  const snapshot = sync.snapshot();
  assert.equal(Object.keys(snapshot.maps.event_requests.items).length, 1);
  assert.equal(snapshot.maps.event_claim_tokens.items[token].data.message_sid, message.sid);
});
test('SMS retry repairs an interrupted token-index create through the same Function handler', async () => {
  const sync = new MockSyncService();
  const store = new Store(null, { sync });
  const functions = createFunctions({ store, baseURL: 'https://event.example' });
  const item = await store.create(message);
  await sync.syncMaps('event_claim_tokens').syncMapItems(item.token).remove();
  const reply = await functions.sms({ MessageSid: message.sid, From: message.from, Body: message.body });
  assert.equal(reply.ticket.token, item.token);
  assert.equal((await store.get(item.token)).sid, message.sid);
  const claim = await functions.claim({ token: item.token, station: 'station-a' });
  const done = await functions.complete({ token: item.token, station: 'station-a',
    lease_id: claim.body.lease_id, verified: true, uid: '04AABBCC' });
  assert.equal(done.body.status, 'complete');
});
test('SMS duplicates share a claim; different URLs from the same phone have separate claims', async () => {
  const store = new Store();
  const first = await store.create(message);
  assert.equal((await store.create(message)).token, first.token);
  assert.notEqual((await store.create({ ...message, sid: 'SM124', body: 'https://example.com/other' })).token, first.token);
  await assert.rejects(() => store.create({ ...message, body: 'https://example.com/changed' }), /conflict/);
  assert.throws(() => validURL('javascript:alert(1)'));
  assert.throws(() => validURL('https://user:pass@example.com'));
  assert.throws(() => validURL('https://example.com https://other.com'));
});
test('station leases prevent simultaneous use and reject stale completion', async () => {
  let now = 1000;
  const store = new Store(null, { now: () => now, lease: 100, lifetime: 10000 });
  const { token } = await store.create(message);
  const first = { ...await store.claim(token, 'station-a') };
  assert.equal((await store.claim(token, 'station-a')).leaseId, first.leaseId);
  await assert.rejects(() => store.claim(token, 'station-b'), /another station/);
  now += 101;
  const second = { ...await store.claim(token, 'station-b') };
  await assert.rejects(() => store.finish(token, { station: 'station-a', leaseId: first.leaseId, verified: true, uid: '04AABBCC' }), /ownership/);
  await assert.rejects(() => store.finish(token, { station: 'station-b', leaseId: second.leaseId, verified: false, uid: '04AABBCC' }), /verified/);
  assert.equal((await store.finish(token, { station: 'station-b', leaseId: second.leaseId, verified: true, uid: '04AABBCC' })).status, 'complete');
  await assert.rejects(() => store.claim(token, 'station-a'), /already/);
  assert.equal((await store.finish(token, { station: 'station-b', leaseId: second.leaseId })).status, 'complete');
});
test('requests and reservations survive restart; expired claims are rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackchan-event-'));
  try {
    const file = path.join(dir, 'requests.json');
    const store = new Store(file, { now: () => 1000, lifetime: 100 });
    const { token } = await store.create(message);
    await store.claim(token, 'station-a');
    assert.equal((await new Store(file, { now: () => 1050 }).get(token)).station, 'station-a');
    await assert.rejects(() => new Store(file, { now: () => 1100 }).get(token), /expired/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
