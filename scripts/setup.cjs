// One-time setup (npm run setup): fetch the StackChan community tools (MOD builder, simulator, gallery,
// firmware installer) at community v2.0.1, install their packages, and restore the simulator and stock
// firmware files. Safe to rerun: each step is skipped once done.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const checkout = path.join(root, 'upstream/stack-chan');
const revision = '6a8f7553610e5d91770901e76fd93a0c50cfd970'; // community v2.0.1
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

if (!fs.existsSync(path.join(checkout, '.git'))) {
  console.log('Downloading the StackChan community tools (about 1 GB)...');
  run('git', ['clone', 'https://github.com/stack-chan/stack-chan.git', checkout]);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim() !== revision)
  run('git', ['-C', checkout, 'checkout', '-B', 'sms-to-nfc', revision]);
if (!fs.existsSync(path.join(checkout, 'web/node_modules'))) {
  console.log('Installing the community tools...');
  run('npm', ['--prefix', path.join(checkout, 'web'), 'ci', '--no-audit', '--no-fund']);
}
run(process.execPath, [path.join(__dirname, 'restore-community-files.cjs')]);
console.log('\nSetup done. Next: npm run deploy -- +1YOURNUMBER   (the Twilio number guests will text)');
