// 115 Open API 客户端
import {
  Driver115Addition,
  Cloud115File,
  Cloud115ListResp,
  Cloud115UserInfoResp,
  Cloud115DownResp,
} from "./types"

// Keep this as the host root; API paths below already start with /open/.
const API_BASE = "https://proapi.115.com"
const UA = "Mozilla/5.0 115disk/42.0.0.2"

export class Client115 {
  private accessToken: string
  private refreshToken: string
  private addition: Driver115Addition
  private rootId: string

  constructor(addition: Driver115Addition) {
    this.addition = addition
    this.accessToken = addition.access_token || ""
    this.refreshToken = addition.refresh_token || ""
    this.rootId = addition.root_folder_id || "0"
  }

  getRootFolderId(): string {
    return this.rootId
  }

  async init(): Promise<void> {
    if (!this.accessToken) {
      throw new Error("[115] access_token is required")
    }
    await this.getUserInfo()
  }

  private async request<T = any>(
    path: string,
    body: Record<string, any> = {},
    base: string = API_BASE,
    method: "GET" | "POST" = "POST",
  ): Promise<T> {
    const url = new URL(`${base}${path}`)
    const headers: Record<string, string> = {
      "User-Agent": UA,
      Accept: "application/json",
    }
    const requestInit: RequestInit = { method, headers }

    if (method === "GET") {
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value))
        }
      }
    } else {
      headers["Content-Type"] = "application/json"
      requestInit.body = JSON.stringify(body)
    }

    const resp = await fetch(url, {
      ...requestInit,
      headers: {
        ...headers,
        Authorization: `Bearer ${this.accessToken}`,
      },
    })
    const rawBody = await resp.text()
    let data: any = {}
    try {
      data = rawBody ? JSON.parse(rawBody) : {}
    } catch {
      // Keep non-JSON error bodies available for diagnosis (for example, an
      // upstream 404 page) instead of collapsing them into "API error".
    }
    const errorCode = data?.errno ?? data?.errcode ?? data?.code
    const hasErrorCode =
      errorCode !== undefined && errorCode !== null && String(errorCode) !== "0"
    if (
      !resp.ok ||
      data?.state === false ||
      data?.errno ||
      data?.errcode ||
      hasErrorCode
    ) {
      // token 过期尝试刷新
      if (
        data.errno === 990001 ||
        data.errcode === 990001 ||
        data.code === 990001 ||
        data.errno === 10008
      ) {
        await this.refreshAccessToken()
        return this.request<T>(path, body, base, method)
      }
      const responseDetail = rawBody.trim().replace(/\s+/g, " ").slice(0, 240)
      const message =
        data?.error ||
        data?.errmsg ||
        data?.message ||
        data?.msg ||
        data?.error_info ||
        responseDetail ||
        "API error"
      const codeSuffix = hasErrorCode
        ? ` (${errorCode})`
        : ` (HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""})`
      throw new Error(`[115] ${message}${codeSuffix} [${url.pathname}]`)
    }
    return data as T
  }

  async getUserInfo(): Promise<Cloud115UserInfoResp> {
    return this.request<Cloud115UserInfoResp>(
      "/open/user/info",
      {},
      API_BASE,
      "GET",
    )
  }

  async refreshAccessToken(): Promise<void> {
    const url = `${API_BASE}/open/oauth2/token`
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
      }),
    })
    const data: any = await resp.json().catch(() => ({}))
    if (data?.access_token) {
      this.accessToken = data.access_token
      this.addition.access_token = data.access_token
      if (data.refresh_token) {
        this.refreshToken = data.refresh_token
        this.addition.refresh_token = data.refresh_token
      }
    } else {
      throw new Error(`[115] refresh token failed: ${JSON.stringify(data)}`)
    }
  }

  async getFiles(cid: string): Promise<Cloud115File[]> {
    // 115's file-list endpoint is GET and returns lower-case file fields.
    const resp = await this.request<Cloud115ListResp>(
      "/open/ufile/files",
      {
        cid,
        limit: 1000,
        offset: 0,
        o: this.addition.order_by || "user_utime",
        asc: this.addition.order_direction === "asc" ? 1 : 0,
        show_dir: 1,
        // Match the OpenList 115 SDK: cur=1 can behave incorrectly for the
        // root directory, so request the normal listing mode.
        cur: 0,
        custom_order: 0,
        stdir: 0,
        star: 0,
      },
      API_BASE,
      "GET",
    )
    const files = Array.isArray(resp?.data)
      ? resp.data
      : Array.isArray(resp?.files)
        ? resp.files
        : []
    return files.map((f: any) => ({
      Fid: String(f.Fid ?? f.fid ?? f.id ?? ""),
      Fn: String(f.Fn ?? f.fn ?? f.n ?? f.file_name ?? f.name ?? ""),
      Fc: String(
        f.Fc ??
          f.fc ??
          f.category ??
          (f.pid !== undefined && !f.pid ? "0" : "1"),
      ),
      FS: Number(f.FS ?? f.fs ?? f.s ?? f.size ?? 0),
      Sha1: f.Sha1 ?? f.sha1,
      Pc: f.Pc ?? f.pc ?? f.pick_code,
      Thumbnail: f.Thumbnail ?? f.thumbnail ?? f.thumb,
      Upt: f.Upt ?? f.upt ?? f.tu ?? f.updated_at,
      Pid: f.Pid ?? f.pid ?? f.cid,
    }))
  }

  /** 通过路径逐级解析文件夹 ID（带缓存由 driver 层管理） */
  async resolvePathId(
    path: string,
    cache: Map<string, string>,
  ): Promise<string> {
    const clean = path.split("/").filter(Boolean).join("/")
    if (!clean) return this.rootId
    if (cache.has(clean)) return cache.get(clean)!

    const parts = clean.split("/")
    let currentId = this.rootId
    for (let i = 0; i < parts.length; i++) {
      const rawPart = parts[i]
      const decoded = (() => {
        try {
          return decodeURIComponent(rawPart)
        } catch {
          return rawPart
        }
      })()
      const files = await this.getFiles(currentId)
      const target = files.find(
        (f) => f.Fn === rawPart || f.Fn === decoded || f.Fid === rawPart,
      )
      if (!target) {
        throw new Error(`[115] Path '${rawPart}' not found in '${currentId}'`)
      }
      currentId = target.Fid
      const subPath = "/" + parts.slice(0, i + 1).join("/")
      cache.set(subPath, currentId)
    }
    return currentId
  }

  async mkdir(pid: string, name: string): Promise<void> {
    await this.request("/open/ufile/add", { pid, cname: name })
  }

  async rename(fid: string, name: string): Promise<void> {
    await this.request("/open/ufile/edit", { fid, fname: name })
  }

  async move(pid: string, fids: string[]): Promise<void> {
    await this.request("/open/ufile/move", { pid, fid: fids, no_dupli: "1" })
  }

  async copy(pid: string, fids: string[]): Promise<void> {
    await this.request("/open/ufile/copy", { pid, fid: fids, no_dupli: "1" })
  }

  async remove(fids: string[]): Promise<void> {
    await this.request("/open/ufile/delete", { fid: fids, ignore_warn: 1 })
  }

  async getDownloadUrl(pickCode: string): Promise<string> {
    const resp = await this.request<Cloud115DownResp>("/open/ufile/downurl", {
      pickcode: pickCode,
    })
    const url = resp?.url || resp?.data?.url || ""
    if (!url) throw new Error("[115] empty download url")
    return url
  }
}
