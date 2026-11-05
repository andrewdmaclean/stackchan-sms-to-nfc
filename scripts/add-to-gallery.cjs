// Add the event MOD to the existing local community Gallery, using its standard simulator and WebSerial
// installation controls.
const fs = require('node:fs');
const path = require('node:path');

module.exports = function prepareGallery({ checkout, source, output, eventConfig }) {
  const gallery = path.join(checkout, 'web/mod-gallery');
  const catalogFile = path.join(gallery, 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  catalog.definitions = catalog.definitions.filter(definition => !['samples/event-qr-test/stackchan-mod.json', 'samples/event-claim/stackchan-mod.json'].includes(definition));
  if (eventConfig) {
    const version = fs.readFileSync(path.join(source, 'mod.js'), 'utf8').match(/^const VERSION = '([^']+)'/m)?.[1];
    if (!version) throw new Error('VERSION not found in robot/mod.js');
    const eventDirectory = path.join(gallery, 'samples/sms-to-nfc');
    const eventMod = path.join(eventDirectory, 'mod');
    fs.mkdirSync(path.join(eventMod, 'vendor'), { recursive: true });
    for (const file of ['mod.js', 'controller.js', 'http.js', 'look-around.js', 'text-me-screen.js', 'qr-decoder.js', 'manifest.json', 'vendor/UPSTREAM.md', 'vendor/cam2qr.js', 'vendor/cam2qr-LICENSE', 'vendor/st25r3916.js', 'vendor/amazon-root-ca1.js'])
      fs.copyFileSync(path.join(source, file), path.join(eventMod, file));
    // Gallery source uses an example; never publish the actual config.js source.
    fs.copyFileSync(path.join(source, 'config.example.js'), path.join(eventMod, 'config.js'));
    fs.copyFileSync(path.join(output, 'sms-to-nfc.xsa'), path.join(eventDirectory, 'sms-to-nfc.xsa'));
    fs.writeFileSync(path.join(eventDirectory, 'stackchan-mod.json'), JSON.stringify({
      format: 'tech.stackchan.mod', schemaVersion: 1,
      id: 'local.stackchan.sms-to-nfc', version, type: 'text',
      name: `SMS to NFC v${version}` + (eventConfig.enableNFCWrite ? '' : ' (NFC off)') + (eventConfig.motion === false ? ' · no motion' : ''),
      description: eventConfig.secure
        ? (eventConfig.enableNFCWrite ? 'Tap a card, show the QR texted from the Twilio number, and it writes your link to the card and celebrates.' : 'Pat its head and show the QR texted from the Twilio number; NFC writing is disabled.') + ` Claims links from ${eventConfig.host} over HTTPS. Looks around while waiting.`
        : 'Configure the backend with npm run deploy before building.',
      source: { path: 'mod/manifest.json', entrypoint: 'mod/mod.js' },
      entrypoints: ['mod'], targets: ['m5stackchan-cores3'],
      capabilities: ['face', 'ui.drawer', 'connectivity.network', 'motion', 'lighting', 'input.headTouch'],
      artifacts: [{ format: 'xsa', path: 'sms-to-nfc.xsa', target: 'm5stackchan-cores3' }],
    }, null, 2) + '\n');
    const eventDefinition = 'samples/sms-to-nfc/stackchan-mod.json';
    if (!catalog.definitions.includes(eventDefinition)) catalog.definitions.unshift(eventDefinition);
  }
  fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2) + '\n');
};
