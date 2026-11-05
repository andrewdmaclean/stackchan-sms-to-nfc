const crypto = require('node:crypto');

class EventError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function validURL(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 500) throw new EventError('Send one URL of at most 500 bytes.');
  const value = text.trim();
  let url;
  try { url = new URL(value); } catch { throw new EventError('Send one complete http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /\s/.test(value))
    throw new EventError('Send one http:// or https:// URL without credentials or spaces.');
  return url.href;
}
// Twilio Functions inject client.sync.v1.services(SYNC_SERVICE_SID); local runs use the mock.
class Store {
  constructor(file, { sync, now = Date.now, lifetime = 86400000, lease = 120000, timeZone = 'America/Vancouver' } = {}) {
    this.now = now; this.lifetime = lifetime; this.lease = lease;
    this.sync = sync || new (require('./mock-sync.cjs').MockSyncService)(file, { now });
    this.requests = this.sync.syncMaps('event_requests').syncMapItems;
    this.claims = this.sync.syncMaps('event_claim_tokens').syncMapItems;
    this.stats = this.sync.syncMaps('event_stats').syncMapItems;
    this.day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  ttl(item) { return Math.max(1, Math.ceil((item.expires - this.now()) / 1000)); }
  async create({ sid, from, body }) {
    if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(sid) ||
        typeof from !== 'string' || !/^\+[1-9]\d{6,14}$/.test(from)) throw new EventError('Invalid message identity.');
    const url = validURL(body);
    let resource;
    try { resource = await this.requests(sid).fetch(); }
    catch (error) { if (error.status !== 404) throw error; }
    if (!resource) {
      // 10 base64url characters (60 random bits) keep "SC1:<token>" in a 21x21 QR, which a 160x120 camera reads
      // from further away. Single-use, 24-hour codes do not need more; 22-character codes remain valid.
      const data = { schema: 1, token: crypto.randomBytes(8).toString('base64url').slice(0, 10), sid, from, url,
        created: this.now(), expires: this.now() + this.lifetime, status: 'pending' };
      try { resource = await this.requests.create({ key: sid, data, ttl: this.ttl(data) }); }
      catch (error) {
        if (error.status !== 409) throw error;
        resource = await this.requests(sid).fetch();
      }
    }
    const item = resource.data;
    if (item.from !== from || item.url !== url) throw new EventError('Message identity conflict.', 409);
    if (item.expires <= this.now()) throw new EventError('Claim expired.', 410);
    // Repair a missing token index on retries after an interrupted two-map create.
    try { await this.claims.create({ key: item.token, data: { schema: 1, message_sid: sid }, ttl: this.ttl(item) }); }
    catch (error) {
      if (error.status !== 409) throw error;
      const indexed = await this.claims(item.token).fetch();
      if (indexed.data.message_sid !== sid) throw new EventError('Token collision.', 409);
    }
    return item;
  }
  async resource(token) {
    if (typeof token !== 'string' || !/^(?:[A-Za-z0-9_-]{10}|[A-Za-z0-9_-]{22})$/.test(token)) throw new EventError('Invalid claim.', 404);
    let resource;
    try {
      const index = await this.claims(token).fetch();
      resource = await this.requests(index.data.message_sid).fetch();
    } catch (error) {
      if (error.status === 404) throw new EventError('Claim not found or expired.', 404);
      throw error;
    }
    if (resource.data.token !== token) throw new EventError('Invalid claim.', 404);
    if (resource.data.expires <= this.now()) throw new EventError('Claim expired. Send your URL again.', 410);
    return resource;
  }
  async get(token) { return (await this.resource(token)).data; }
  async mutate(token, change) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const resource = await this.resource(token);
      const next = change(resource.data);
      if (!next) return resource.data;
      try {
        return (await this.requests(resource.key).update({ data: next, ifMatch: resource.revision })).data;
      } catch (error) { if (error.status !== 412) throw error; }
    }
    throw new EventError('Request changed concurrently. Please retry.', 409);
  }
  async claim(token, station) {
    if (typeof station !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(station)) throw new EventError('Invalid station.');
    return this.mutate(token, item => {
      if (item.status === 'complete') throw new EventError('This request has already been written.', 409);
      if (item.status === 'reserved' && item.leaseUntil > this.now()) {
        if (item.station !== station) throw new EventError('This request is in use at another station.', 409);
        return null;
      }
      return { ...item, status: 'reserved', station, leaseId: crypto.randomBytes(16).toString('hex'), leaseUntil: this.now() + this.lease };
    });
  }
  async finish(token, { station, leaseId, verified, uid }) {
    return this.mutate(token, item => {
      if (item.station !== station || item.leaseId !== leaseId) throw new EventError('Claim ownership changed.', 409);
      if (item.status === 'complete') return null;
      if (item.status !== 'reserved' || item.leaseUntil <= this.now()) throw new EventError('Reservation expired.', 409);
      if (verified !== true || typeof uid !== 'string' || !/^[0-9a-fA-F]{8,20}$/.test(uid))
        throw new EventError('A verified write and hexadecimal tag UID are required.');
      return { ...item, status: 'complete', completed: this.now(), uid };
    });
  }
  // Give a completed request today's next card number, once. A retry after a lost reply returns the same number;
  // a counter bump whose request update then fails is skipped (the count is for fun, not accounting).
  async number(token) {
    const item = await this.get(token);
    if (item.status !== 'complete' || item.card !== undefined) return { item, assigned: false };
    const day = this.day.format(this.now());
    const card = await this.nextCard(day);
    const updated = await this.mutate(token, current => current.card !== undefined ? null : { ...current, card, cardDay: day });
    return { item: updated, assigned: updated.card === card };
  }
  async nextCard(day) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let resource;
      try { resource = await this.stats(day).fetch(); }
      catch (error) {
        if (error.status !== 404) throw error;
        try { await this.stats.create({ key: day, data: { schema: 1, cards: 1 } }); return 1; }
        catch (error) { if (error.status !== 409) throw error; continue; }
      }
      const cards = resource.data.cards + 1;
      try { await this.stats(day).update({ data: { ...resource.data, cards }, ifMatch: resource.revision }); return cards; }
      catch (error) { if (error.status !== 412) throw error; }
    }
    throw new EventError('Card counter is busy. Please retry.', 409);
  }
}
module.exports = { Store, EventError, validURL };
