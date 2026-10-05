export const encode = (value) => new TextEncoder().encode(value)
export const decode = (value) => new TextDecoder().decode(value)
export function concat(...parts) {
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    data.set(part, offset)
    offset += part.length
  }
  return data
}

// One consumer, bounded buffering. Pause the transport pump at the high-water mark.
export class AsyncQueue {
  constructor(limit = 512 * 1024) {
    this.limit = limit
    this.parts = []
    this.bytes = 0
    this.done = false
  }
  push(data) {
    if (this.done || !data.length) return
    this.parts.push(data)
    this.bytes += data.length
    if (this.bytes > this.limit * 2) throw new Error("receive_limit")
    this.wake?.()
    this.wake = undefined
  }
  finish(error) {
    if (this.done) return
    this.done = true
    this.error = error
    this.wake?.()
    this.wake = undefined
    this.drain?.()
    this.drain = undefined
  }
  async capacity() {
    while (this.bytes >= this.limit && !this.done)
      await new Promise((resolve) => {
        this.drain = resolve
      })
  }
  async read() {
    while (!this.parts.length && !this.done)
      await new Promise((resolve) => {
        this.wake = resolve
      })
    const data = this.parts.shift()
    if (data) {
      this.bytes -= data.length
      this.drain?.()
      this.drain = undefined
      return data
    }
    if (this.error) throw this.error
    return undefined
  }
}

export class ByteReader {
  constructor(read) {
    this.next = read
    this.buffer = new Uint8Array()
  }
  async part(max = 16384) {
    while (!this.buffer.length) {
      const data = await this.next()
      if (!data) return undefined
      this.buffer = data
    }
    const out = this.buffer.slice(0, max)
    this.buffer = this.buffer.subarray(out.length)
    return out
  }
  async exact(n) {
    const parts = []
    let size = 0
    while (size < n) {
      const data = await this.part(n - size)
      if (!data) {
        if (!size) return undefined
        throw new Error("truncated_stream")
      }
      parts.push(data)
      size += data.length
    }
    return concat(...parts)
  }
  async line(limit = 16384) {
    const parts = []
    let size = 0
    for (;;) {
      for (let i = 0; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          size += i
          if (size > limit) throw new Error("header_limit")
          parts.push(this.buffer.slice(0, i))
          this.buffer = this.buffer.subarray(i + 2)
          return decode(concat(...parts))
        }
      }
      if (this.buffer.length > 1) {
        const take = this.buffer.length - 1
        parts.push(this.buffer.slice(0, take))
        size += take
        this.buffer = this.buffer.subarray(take)
      }
      if (size > limit) throw new Error("header_limit")
      const data = await this.next()
      if (!data) throw new Error("truncated_headers")
      this.buffer = concat(this.buffer, data)
    }
  }
}
