// Restore release simulator and CoreS3 host binaries from the local Git checkout.
// No network requests, SDK installation, firmware build, or device flashing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const checkout = path.join(root, 'upstream/stack-chan');
const sourceRevision = '6a8f7553610e5d91770901e76fd93a0c50cfd970';
const deploymentRevision = '869c02201877dcfce7bc3a3d3271a161dd67c777';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
if (head !== sourceRevision) throw new Error(`Expected community v2.0.1 (${sourceRevision}); found ${head}.`);
const deploymentSubject = execFileSync('git', ['show', '-s', '--format=%s', deploymentRevision], { cwd: checkout, encoding: 'utf8' }).trim();
if (!deploymentSubject.endsWith(`from ${sourceRevision}`)) throw new Error('Simulator deployment does not match the source revision.');
const files = [];
const artifacts = ['web/simulator/mc.js', 'web/simulator/mc.wasm'];
for (const name of ['manifest_esp32_m5stackchan_cores3.json', 'manifest_esp32_m5stack_cores3.json']) {
  const relative = `web/flash/${name}`;
  const manifest = JSON.parse(fs.readFileSync(path.join(checkout, relative), 'utf8'));
  const published = JSON.parse(execFileSync('git', ['show', `${deploymentRevision}:${relative}`], { cwd: checkout, encoding: 'utf8' }));
  if (JSON.stringify(manifest) !== JSON.stringify(published)) throw new Error(`Release manifest differs from the source checkout: ${name}`);
  for (const build of manifest.builds) for (const part of build.parts) artifacts.push(`web/flash/${part.path}`);
}
for (const relative of new Set(artifacts)) {
  const bytes = execFileSync('git', ['show', `${deploymentRevision}:${relative}`], { cwd: checkout, maxBuffer: 64 * 1024 * 1024 });
  if (relative.endsWith('.wasm') && !bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error('Invalid WebAssembly binary.');
  fs.mkdirSync(path.dirname(path.join(checkout, relative)), { recursive: true });
  fs.writeFileSync(path.join(checkout, relative), bytes);
  files.push({ path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
const output = path.join(root, '.artifacts');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'community-simulator.json'), JSON.stringify({ source_revision: sourceRevision, deployment_revision: deploymentRevision, deployment_subject: deploymentSubject, files }, null, 2));
console.log('Community v2.0.1 simulator and CoreS3 host binaries restored from local release Git history.');
console.log('Start the tools with npm start.');
console.log('Firmware installer: http://127.0.0.1:5173/flash/ (replaces firmware and clears settings if you confirm a write).');
