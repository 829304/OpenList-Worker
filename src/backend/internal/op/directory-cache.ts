import type { FileItem } from "../driver/base"
import { sha256 } from "../../pkg/crypto"

type Backend = Pick<Cache, "match" | "put" | "delete">
type Entry = { expires: number; items: FileItem[]; bytes: number }
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_TTL = 86400

/** Cache raw provider metadata, before user-specific filtering and signing. */
export class DirectoryCache {
  private entries = new Map<string, Entry>()
  private pending = new Map<string, Promise<FileItem[]>>()
  private epochs = new Map<string, string>()
  private bytes = 0

  constructor(
    private backend: () => Promise<Backend | undefined> = async () =>
      typeof caches === "undefined"
        ? undefined
        : caches.open("openlist-directory-v1"),
    private now: () => number = Date.now,
  ) {}

  private drop(key: string) {
    const old = this.entries.get(key)
    if (old) this.bytes -= old.bytes
    this.entries.delete(key)
  }

  private remember(key: string, entry: Entry) {
    this.drop(key)
    while (this.entries.size >= 128 || this.bytes + entry.bytes > MAX_BYTES) {
      this.drop(this.entries.keys().next().value!)
    }
    this.entries.set(key, entry)
    this.bytes += entry.bytes
  }

  private async getBackend() {
    try {
      return await this.backend()
    } catch {
      return undefined
    }
  }

  private epochKey(origin: string, scope: string) {
    return `${origin}/.openlist-cache/directory-v1/${scope}/epoch`
  }

  private async epoch(
    cache: Backend | undefined,
    origin: string,
    scope: string,
  ) {
    if (cache) {
      try {
        const response = await cache.match(this.epochKey(origin, scope))
        if (response) return await response.text()
      } catch {}
    }
    return this.epochs.get(scope) || "0"
  }

  async invalidate(scope: string, origin: string) {
    const epoch = crypto.randomUUID()
    // Rotate the whole storage namespace, including descendants and in-flight
    // reads. A completed old read can only populate the previous namespace.
    this.epochs.set(scope, epoch)
    if (this.epochs.size > 128)
      this.epochs.delete(this.epochs.keys().next().value!)
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${origin}/.openlist-cache/directory-v1/${scope}/`))
        this.drop(key)
    }
    try {
      const cache = await this.getBackend()
      await cache?.put(
        this.epochKey(origin, scope),
        new Response(epoch, {
          // Longer than any listing TTL, so reverting to epoch 0 cannot revive
          // an old listing. Cache API invalidation is local to the serving POP.
          headers: { "Cache-Control": "max-age=604800" },
        }),
      )
    } catch {}
  }

  async list(
    scope: string,
    origin: string,
    path: string,
    minutes: number,
    refresh: boolean,
    load: () => Promise<FileItem[]>,
    onResult?: (source: "memory" | "edge" | "miss" | "bypass") => void,
  ): Promise<FileItem[]> {
    const ttl = Math.min(MAX_TTL, Math.max(0, minutes * 60))
    if (!ttl) {
      onResult?.("bypass")
      return load()
    }
    const cache = await this.getBackend()
    const epoch = await this.epoch(cache, origin, scope)
    const key = `${origin}/.openlist-cache/directory-v1/${scope}/${epoch}/${await sha256(path)}`
    if (refresh) {
      this.drop(key)
      try {
        await cache?.delete(key)
      } catch {}
    } else {
      const memory = this.entries.get(key)
      if (memory && memory.expires > this.now()) {
        onResult?.("memory")
        return structuredClone(memory.items)
      }
      this.drop(key)
      try {
        const response = await cache?.match(key)
        if (response) {
          const entry: Entry = await response.json()
          if (entry.expires > this.now() && Array.isArray(entry.items)) {
            if (entry.bytes <= MAX_ENTRY_BYTES) this.remember(key, entry)
            onResult?.("edge")
            return structuredClone(entry.items)
          }
        }
      } catch {}
    }
    const existing = this.pending.get(key)
    onResult?.("miss")
    if (existing) return structuredClone(await existing)
    const pending = (async () => {
      const items = await load()
      const serialized = JSON.stringify(items)
      const bytes = new TextEncoder().encode(serialized).length
      if (bytes <= MAX_ENTRY_BYTES) {
        const entry = {
          items: JSON.parse(serialized),
          expires: this.now() + ttl * 1000,
          bytes,
        }
        this.remember(key, entry)
        try {
          await cache?.put(
            key,
            Response.json(entry, {
              headers: { "Cache-Control": `max-age=${Math.ceil(ttl)}` },
            }),
          )
        } catch {}
      }
      return items
    })()
    this.pending.set(key, pending)
    try {
      return structuredClone(await pending)
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key)
    }
  }
}

export const directoryCache = new DirectoryCache()

export async function directoryCacheScope(storage: any): Promise<string> {
  // Hash account/configuration identity; no token or private path in cache URLs.
  return sha256(
    JSON.stringify({
      id: storage.id,
      modified: storage.modified,
      mount: storage.mount_path,
      addition: storage.addition,
    }),
  )
}
