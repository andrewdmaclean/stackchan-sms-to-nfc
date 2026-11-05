// The same checks run under Node and the real XS interpreter, with no browser APIs.
export function makeFrame(fixture) {
  const { width, height, matrix, scale, bigEndian, rotated, blank } = fixture
  const left = Math.floor((width - matrix.size * scale) / 2), top = Math.floor((height - matrix.size * scale) / 2)
  const buffer = new ArrayBuffer(width * height * 2)
  const bytes = new Uint8Array(buffer)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const mx = Math.floor((x - left) / scale), my = Math.floor((y - top) / scale)
    const inside = mx >= 0 && my >= 0 && mx < matrix.size && my < matrix.size
    const index = rotated ? (matrix.size - 1 - mx) * matrix.size + my : my * matrix.size + mx
    const black = !blank && inside && matrix.data[index]
    const pixel = black ? 0x0000 : 0xffde
    const offset = (y * width + x) * 2
    bytes[offset] = bigEndian ? pixel >> 8 : pixel & 255
    bytes[offset + 1] = bigEndian ? pixel & 255 : pixel >> 8
  }
  return { width, height, imageType: bigEndian ? 'rgb565be' : 'rgb565le', buffer }
}

export function runQRChecks(Decoder, fixtures) {
  const decoder = new Decoder()
  const results = []
  for (const fixture of fixtures) {
    const frame = makeFrame(fixture)
    const started = Date.now()
    const result = decoder.decode(frame)
    if (result !== fixture.payload) throw new Error(`${fixture.name}: expected ${fixture.payload}, received ${result}`)
    results.push({ name: fixture.name, passed: true, elapsed_ms: Date.now() - started, camera_bytes: frame.buffer.byteLength })
  }
  const frame = makeFrame(fixtures[0])
  for (let i = 0; i < 20; i++)
    if (decoder.decode(frame) !== fixtures[0].payload) throw new Error('Repeated-frame decoding failed')
  const invalid = [
    { ...frame, width: 640, height: 480 },
    { ...frame, buffer: new ArrayBuffer(10) },
    { ...frame, imageType: 'jpeg' },
  ]
  for (const candidate of invalid) {
    let threw = false
    try { decoder.decode(candidate) } catch { threw = true }
    if (!threw) throw new Error('Invalid frame was accepted')
  }
  decoder.close()
  return { results, repeated_frames: 20, invalid_frames_rejected: invalid.length }
}
