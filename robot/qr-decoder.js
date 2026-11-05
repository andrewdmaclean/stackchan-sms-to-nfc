import decode from './vendor/cam2qr.js'
export default class Cam2QRDecoder {
  decode(frame) {
    const { width, height, imageType, buffer } = frame
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 80 || height < 80 || width > 320 || height > 240 || width % 2 || height % 2)
      throw new RangeError('QR frame exceeds the configured size limit')
    if (!['rgb565le', 'rgb565be'].includes(imageType)) throw new TypeError('QR frame must be RGB565')
    if (!buffer || buffer.byteLength !== width * height * 2) throw new RangeError('Invalid RGB565 byte length')
    // Every camera pixel: at 160x120 a phone QR reads from about twice as far away as at half resolution.
    const result = decode({data:new Uint8Array(buffer),width,height,bigEndian:imageType==='rgb565be'}, {tryInverted:false})
    return result && /^SC1:(?:[A-Za-z0-9_-]{10}|[A-Za-z0-9_-]{22})$/.test(result.text) ? result.text : undefined
  }
  close() {}
}
