// Runs the robot's QR decoder (cam2qr) in Moddable's desktop XS engine. Uses a pre-existing XS interpreter;
// never installs or downloads anything.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixtures, fixture } = require('../tests/qr-fixtures.cjs');
const root = path.resolve(__dirname, '..');
const executable = process.env.XST || path.join(root, '.cache/qr-js/xst');
if (!fs.existsSync(executable)) {
  console.error('Set XST to a Moddable SDK 10.0.2 xst interpreter. This command does not download or install tools.');
  process.exit(1);
}
require('./build-cam2qr.cjs')(path.join(root, 'robot/vendor'));
const output = path.join(root, '.artifacts');
fs.mkdirSync(output, { recursive: true });
// Real ticket codes (short and long) plus mixed-segment and non-claim codes.
const cases = [...fixtures(), fixture('real-ticket-token', 'SC1:ScyLk__NVL7gel3oPNGLCg')];
const script = path.join(output, 'qr-xs-check.mjs');
fs.writeFileSync(script, `import Decoder from ${JSON.stringify(path.join(root, 'robot/qr-decoder.js'))};\n` +
  `import {runQRChecks} from ${JSON.stringify(path.join(root, 'tests/qr-runtime-check.mjs'))};\n` +
  // Desktop xst has TextEncoder/TextDecoder; the robot firmware does not. Remove them to match the robot.
  `delete globalThis.TextEncoder; delete globalThis.TextDecoder;\n` +
  `print(JSON.stringify(runQRChecks(Decoder,${JSON.stringify(cases)})));\n`);
const version = execFileSync(executable, ['-v'], { encoding: 'utf8' }).trim();
const result = JSON.parse(execFileSync(executable, ['-m', script], { encoding: 'utf8', timeout: 120000 }).trim());
fs.writeFileSync(path.join(output, 'qr-js-xs.json'), JSON.stringify({ engine: version, decoder: 'cam2qr', runtime: 'desktop XS; not ESP32 hardware', ...result }, null, 2));
console.log(version);
console.log(`cam2qr: ${result.results.length} image checks, ${result.repeated_frames} repeated frames, ${result.invalid_frames_rejected} rejected invalid frames: PASS`);
console.log('Report: .artifacts/qr-js-xs.json (desktop timings are not robot timings)');
