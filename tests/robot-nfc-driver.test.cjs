const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function fixture(t, { nack = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackchan-st25-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = fs.readFileSync(path.join(__dirname, '../robot/vendor/st25r3916.js'), 'utf8')
    .replace('from "timer"', 'from "./timer.mjs"')
    .replace('from "embedded:sensor/RFID/ndef"', 'from "./ndef.mjs"');
  fs.writeFileSync(path.join(dir, 'driver.mjs'), src);
  fs.writeFileSync(path.join(dir, 'timer.mjs'), 'export default { delay() {} };');
  fs.writeFileSync(path.join(dir, 'ndef.mjs'), `export const NDEF_MAX=128; export function encodeNdefOptions(){return Uint8Array.of(3,3,1,2,3,254)}; export function extractNdefTlv(){return Uint8Array.of(1)}; export function wrapNdef(){return {records:[{tnf:1,type:'U',uri:'https://example.com'}]}}`);
  const { default: Driver } = await import(pathToFileURL(path.join(dir, 'driver.mjs')));
  const exchanges = [];
  class FakeBus {
    constructor() { this.reg = new Uint8Array(64); this.fifo = []; this.tx = []; FakeBus.instance = this; }
    writeUint8(reg, value) { this.reg[reg] = value; }
    readUint8(reg) { if (reg === 0x7f) return 0x28; if (reg === 0x71) return 0x10; return this.reg[reg & 0x3f]; }
    writeBuffer(reg, data) { if (reg === 0x80) this.tx = Array.from(data); }
    readBuffer(reg, out) {
      out.fill(0);
      if (reg === 0x5a) { out[0] = 0x98; out[1] = 0x80; }
      else if (reg === 0x5e) out[0] = this.fifo.length;
      else if (reg === 0x9f) out.set(this.fifo.slice(0, out.length));
    }
    sendByte(cmd) {
      if (cmd === 0xc6 || cmd === 0xc7) this.fifo = [0x44, 0];
      if (cmd !== 0xc4 && cmd !== 0xc5) return;
      if (this.tx[0] === 0x93 && this.tx[1] === 0x20) this.fifo = [4, 1, 2, 3, 4];
      else if (this.tx[0] === 0x93 && this.tx[1] === 0x70) this.fifo = [0];
      else if (this.tx[0] === 0x30) {
        exchanges.push({ operation: 'read', aux: this.reg[0x0a] });
        this.fifo = this.tx[1] === 3 ? [0xe1, 0x10, 0x12, 0, ...Array(12).fill(0)] : Array(16).fill(0);
      } else if (this.tx[0] === 0xa2) {
        exchanges.push({ operation: 'write', aux: this.reg[0x0a], command: cmd });
        this.fifo = (this.reg[0x0a] & 0x80) && !nack ? [0x0a] : [];
      } else this.fifo = [];
    }
    close() {}
  }
  return { reader: new Driver({ sensor: { io: FakeBus } }), exchanges, bus: FakeBus.instance };
}

test('Type 2 writes accept CRC-less ACKs and restore CRC for read-back', async t => {
  const f = await fixture(t);
  const result = f.reader.writeNDEF({ uri: 'https://example.com' });
  assert.equal(result.records[0].uri, 'https://example.com');
  const writes = f.exchanges.filter(x => x.operation === 'write');
  assert.equal(writes.length, 2);
  assert.ok(writes.every(x => (x.aux & 0x80) && x.command === 0xc4));
  assert.ok(f.exchanges.filter(x => x.operation === 'read').every(x => !(x.aux & 0x80)));
  f.reader.close();
});

test('failed Type 2 write restores the original CRC setting', async t => {
  const f = await fixture(t, { nack: true });
  assert.throws(() => f.reader.writeNDEF({ uri: 'https://example.com' }), /writePage failed/);
  assert.equal(f.bus.reg[0x0a] & 0x80, 0);
  f.reader.close();
});
