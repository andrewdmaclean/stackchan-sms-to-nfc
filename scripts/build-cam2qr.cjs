// Derive an ASCII-token-only RGB565 adapter from the pinned MIT-licensed cam2qr release.
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
module.exports = function buildCam2QR(directory) {
let s=fs.readFileSync(path.join(directory,'cam2qr-original.js'),'utf8');
if(crypto.createHash('sha256').update(s).digest('hex')!=='41112e265413cbf669196812bb3be04715d882e14005fc32c211cb9267cd11f6') throw Error('Unexpected cam2qr source; review before deriving.');
s=s.replaceAll(String.fromCharCode(29), '\\x1D');
const errorName='    this.name = "DecodeError";';
if(!s.includes(errorName)) throw Error('Expected cam2qr error name assignment.');
// Error.prototype may be frozen in the community MOD compartment.
s=s.replace(errorName, '    // Keep the inherited error name: it may be read-only in a MOD.');
const a=s.indexOf('function decodeBytes(bytes, eci) {'), b=s.indexOf('\nfunction decodeNumeric(',a);
if(a<0||b<0) throw Error('decodeBytes not found');
s=s.slice(0,a)+`function decodeBytes(bytes, eci) {
  let text = '';
  for (const byte of bytes) { if (byte > 127) throw new Error('Non-ASCII QR payload'); text += String.fromCharCode(byte); }
  return text;
}\n`+s.slice(b);
// The robot's XS runtime has no TextEncoder/TextDecoder. Numeric and alphanumeric segments (the QR library
// puts runs like "SC1:S" in one) are ASCII, and Kanji is outside the claim format.
const utf8='function encodeUtf8(text) {\n  textEncoder ?? (textEncoder = new TextEncoder());\n  return textEncoder.encode(text);\n}';
if(!s.includes(utf8)) throw Error('encodeUtf8 not found');
s=s.replace(utf8,`function encodeUtf8(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); if (code > 127) throw new Error('Non-ASCII QR payload'); bytes[i] = code; }
  return bytes;
}`);
const sjis='function decodeShiftJis(bytes) {\n  try {\n    return new TextDecoder("shift_jis").decode(bytes);\n  } catch {\n    throw new DecodeError("unsupported-mode", "no Shift-JIS decoder available in this runtime");\n  }\n}';
if(!s.includes(sjis)) throw Error('decodeShiftJis not found');
s=s.replace(sjis,'function decodeShiftJis(bytes) {\n  throw new DecodeError("unsupported-mode", "Kanji QR data is not a claim token");\n}');
if(/\bText(En|De)coder\b(?!\s*;)/.test(s.replace('var textEncoder;',''))) throw Error('cam2qr still uses TextEncoder/TextDecoder, which the robot lacks.');
const c=s.indexOf('function toGrayscale(image) {'), d=s.indexOf('\n// src/decode.ts',c);
if(c<0||d<0) throw Error('toGrayscale not found');
// step 2 samples every other pixel of each other row; step 1 uses every camera pixel.
s=s.slice(0,c)+`function toGrayscale(image) {
  const { data, width, height, bigEndian, step = 1 } = image;
  if (data.length !== width*height*2*step*step) throw new Error('Invalid RGB565 frame');
  const luma=new Uint8Array(width*height), stride=width*step;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=(y*step*stride+x*step)*2;
    const p=bigEndian ? (data[i]<<8)|data[i+1] : data[i]|(data[i+1]<<8);
    const r=((p>>11)&31)*255/31, g=((p>>5)&63)*255/63, b=(p&31)*255/31;
    luma[y*width+x]=(77*r+150*g+29*b)>>8;
  }
  return {luma,width,height};
}\n`+s.slice(d);
const original='export { BitMatrix, DecodeError, decode, decodeAll, decodeMatrix, detect, parseContent, scanFrame };';
if(!s.includes(original)) throw Error('export not found');
s=s.replace(original,'export { DecodeError };\nexport default decode;');
s='// Derived from cam2qr 1.4.0; ASCII-only claim data and RGB565 input. See cam2qr-LICENSE.\n'+s.replace(/^\/\/# sourceMappingURL=.*$/gm,'');
fs.writeFileSync(path.join(directory,'cam2qr.js'),s);
};
