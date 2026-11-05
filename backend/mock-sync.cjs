// Local Sync MapItem helper-library subset; no Twilio account or network access.
const fs = require('node:fs');
const path = require('node:path');
const clone = value => JSON.parse(JSON.stringify(value));
const failure = (status, message) => Object.assign(new Error(message), { status });
class MockSyncService {
  constructor(file, { now = Date.now } = {}) {
    this.file = file; this.now = now;
    this.state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, maps: {} };
    if (this.state.version !== 1) throw new Error('Unsupported mock Sync file format.');
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  // Local maps are provisioned lazily. Live Sync maps must be created in advance.
  syncMaps(name) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw failure(400, 'Invalid mock map name.');
    if (!Object.hasOwn(this.state.maps, name)) {
      this.state.maps[name] = { revision: 0, items: {} }; this.save();
    }
    const map = this.state.maps[name];
    const read = key => {
      let item = Object.hasOwn(map.items, key) ? map.items[key] : undefined;
      if (item?.dateExpires && Date.parse(item.dateExpires) <= this.now()) {
        delete map.items[key]; this.save(); item = undefined;
      }
      if (!item) throw failure(404, 'Sync MapItem not found.');
      return item;
    };
    const validate = data => {
      if (!data || typeof data !== 'object' || Array.isArray(data) || Buffer.byteLength(JSON.stringify(data)) > 16384)
        throw failure(400, 'Sync data must be a JSON object of at most 16 KiB.');
    };
    const syncMapItems = key => ({
      fetch: async () => clone(read(key)),
      update: async ({ data, ifMatch, ttl }) => {
        const current = read(key);
        if (ifMatch !== undefined && current.revision !== ifMatch) throw failure(412, 'Sync revision mismatch.');
        validate(data);
        const item = { ...current, data: clone(data), revision: String(++map.revision), dateUpdated: new Date(this.now()).toISOString() };
        if (ttl !== undefined) item.dateExpires = ttl === 0 ? null : new Date(this.now() + ttl * 1000).toISOString();
        map.items[key] = item; this.save(); return clone(item);
      },
      remove: async ({ ifMatch } = {}) => {
        const current = read(key);
        if (ifMatch !== undefined && current.revision !== ifMatch) throw failure(412, 'Sync revision mismatch.');
        delete map.items[key]; this.save(); return true;
      },
    });
    syncMapItems.create = async ({ key, data, ttl }) => {
      if (typeof key !== 'string' || !key.length || key.length > 320 || ['__proto__', 'constructor', 'prototype'].includes(key))
        throw failure(400, 'Invalid Sync item key.');
      try { read(key); throw failure(409, 'Sync MapItem already exists.'); }
      catch (error) { if (error.status !== 404) throw error; }
      validate(data);
      const timestamp = new Date(this.now()).toISOString();
      const item = { key, data: clone(data), revision: String(++map.revision), dateCreated: timestamp,
        dateUpdated: timestamp, dateExpires: ttl ? new Date(this.now() + ttl * 1000).toISOString() : null };
      map.items[key] = item; this.save(); return clone(item);
    };
    return { syncMapItems };
  }
  snapshot() { return clone(this.state); }
}
module.exports = { MockSyncService };
