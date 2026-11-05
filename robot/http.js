import Timer from 'timer'
import twilioRootCA from 'vendor/amazon-root-ca1'

// Uses the same ECMA-419 device.network client as the community firmware.
// HTTPS trusts only the root passed as `ca` (default: twil.io's Amazon Root CA 1).
export function createPost(config) {
  return (path, data) => new Promise((resolve, reject) => {
    let client, timeout, finished = false, status = 0, offset = 0, length = 0
    const body = ArrayBuffer.fromString(JSON.stringify(data))
    const response = new Uint8Array(2048)
    const finish = (error, value) => {
      if (finished) return
      finished = true
      if (timeout !== undefined) Timer.clear(timeout)
      client?.close()
      if (error) reject(error)
      else resolve(value)
    }
    try {
      const network = config.secure ? device.network.https.client : device.network.http.client
      const socket = config.secure
        ? { ...network.socket, tls: { ...network.socket?.tls, ca: config.ca ?? twilioRootCA } } : network.socket
      client = new network.io({ ...network, socket, host: config.host, port: config.port })
      timeout = Timer.set(() => finish(new Error('Backend request timed out')), 10000)
      client.request({
        method: 'POST', path,
        headers: new Map([['content-type', 'application/json'], ['content-length', String(body.byteLength)],
          ['authorization', `Bearer ${config.token}`], ['connection', 'close']]),
        onHeaders(code) { status = code },
        onWritable(count) {
          const use = Math.min(count, body.byteLength - offset)
          if (use > 0) { this.write(new DataView(body, offset, use)); offset += use }
        },
        onReadable(count) {
          if (count > response.byteLength - length) return finish(new Error('Backend response too large'))
          const chunk = this.read(count)
          response.set(new Uint8Array(chunk), length)
          length += chunk.byteLength
        },
        onDone(error) {
          if (finished) return
          try {
            if (error) throw error
            // Errors carry the HTTP status. A non-JSON body (a Twilio error page) reports the status, not a parse error.
            let reply
            try { reply = JSON.parse(String.fromArrayBuffer(response.buffer.slice(0, length))) } catch {}
            if (status !== 200) throw Object.assign(new Error(reply?.error || `HTTP ${status}`), { status })
            if (reply === undefined) throw new Error('Invalid backend response')
            finish(null, reply)
          } catch (error) { finish(error) }
        },
      })
    } catch (error) { finish(error) }
  })
}
