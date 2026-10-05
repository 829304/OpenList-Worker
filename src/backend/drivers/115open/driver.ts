// 115 Open (115网盘开放平台) driver
// Re-ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/115_open
// (driver.go — StorageDriver interface implementation)
import {
  DriverGetOptions,
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { sha1, hmacSha1Base64 } from "../../pkg/crypto"
import { Pan115Addition, Pan115File, Pan115FolderInfoResp } from "./types"
import { Pan115Client, ERR_OBJECT_NOT_FOUND } from "./util"

/** OpenList Go base.UserAgent（与 Go 驱动一致，115 防盗链校验通过率高） */
const OPENLIST_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

/** CF Workers 免费版单次 invocation 子请求预算（留余量） */
const SUBREQUEST_LIMIT = 45

function pan115FileToFileItem(f: Pan115File): FileItem {
  const isDir = f.fc === "0"
  return {
    name: f.fn,
    size: f.fs || 0,
    is_dir: isDir,
    created: f.uppt ? new Date(f.uppt * 1000).toISOString() : undefined,
    modified: f.upt
      ? new Date(f.upt * 1000).toISOString()
      : new Date().toISOString(),
    sign: f.fid,
    type: calcFileType(f.fn, isDir),
    thumb: f.thumbnail || f.fco || "",
    raw_url: "",
  }
}

function pan115FolderInfoToFile(info: Pan115FolderInfoResp): Pan115File | null {
  const fid = String(info.file_id || "").trim()
  const category = String(info.file_category || "").trim()
  const name = String(info.file_name || "")
  if (!fid || !category || !name) return null

  return {
    fid,
    aid: "1",
    pid: "",
    fc: category,
    fn: name,
    fco: "",
    pc: String(info.pick_code || ""),
    upt: Number.parseInt(String(info.utime || "0"), 10) || 0,
    uet: 0,
    uppt: Number.parseInt(String(info.ptime || "0"), 10) || 0,
    sha1: String(info.sha1 || ""),
    fs: Number(info.size_byte) || 0,
    ico: "",
    thumbnail: "",
  }
}

export function normalizePan115Addition(a: any): Pan115Addition {
  const norm = { ...(a || {}) } as any
  norm.order_by = norm.order_by || "file_name"
  norm.order_direction = norm.order_direction || "asc"
  norm.page_size = norm.page_size || 200
  // 兼容 OpenList Go 原版字段名（root_folder_id → root_id）
  if ((norm.root_folder_id || norm.root_folder_id === "0") && !norm.root_id) {
    norm.root_id = String(norm.root_folder_id)
  }
  return norm as Pan115Addition
}

export class Pan115Driver implements StorageDriver {
  private client: Pan115Client
  private addition: Pan115Addition
  private pageSize = 200
  /** root 非默认时，路径前缀（Go Init 计算 parentPath） */
  private parentPath = "/"
  /** cache: 物理路径 → fid（复用） */
  private fidCache = new Map<string, string>()
  /** CF subrequest 预算 */
  private budget = { used: 0, limit: SUBREQUEST_LIMIT }
  /**
   * 下载链接缓存（Go LinkCacheMode=UA 等价）：按 文件ID+UA 缓存，TTL 30 分钟。
   * 115 免费用户 downurl 接口有每日配额（code 406），缓存显著减少调用次数。
   */
  private linkCache = new Map<string, { url: string; expire: number }>()
  private static readonly LINK_TTL_MS = 30 * 60 * 1000

  constructor(
    addition: Pan115Addition,
    onTokenUpdate?: (tokens: {
      access_token: string
      refresh_token: string
    }) => void | Promise<void>,
    proxyEnv?: any,
  ) {
    this.addition = normalizePan115Addition(addition)
    this.client = new Pan115Client(this.addition, onTokenUpdate, proxyEnv)
  }

  async init(options: { validateCredentials?: boolean } = {}): Promise<void> {
    const a = this.addition
    // page_size 1~1150（Go Init 限制）
    let ps = a.page_size || 200
    if (ps <= 0) ps = 200
    if (ps > 1150) ps = 1150
    this.pageSize = ps

    // 验证 token（失败即挂载失败，给出明确错误）
    if (options.validateCredentials !== false) {
      try {
        await this.client.userInfo()
      } catch (e: any) {
        if (e?.code === ERR_OBJECT_NOT_FOUND) throw e
        const msg = String(e?.message || e)
        if (
          msg.includes("fetch") ||
          msg.includes("ECONN") ||
          msg.includes("abort")
        ) {
          throw new Error(
            `115 网盘网络连接失败（${msg}）：proapi.115.com 可能无法从当前部署环境访问` +
              `（数据中心 IP 可能被 115 拦截），请稍后重试或更换部署环境。`,
          )
        }
        throw new Error(
          `115 网盘 token 验证失败：${msg}。请确认 access_token / refresh_token 有效。`,
        )
      }
    }

    // 非根目录挂载 → 计算路径前缀（Go Init parentPath）
    const rootId = this.getRootId()
    if (rootId !== "0") {
      const info = await this.client.getFolderInfo(rootId)
      if (info.file_id !== "0") {
        this.parentPath = `/${info.file_name}`
        const paths = [...(info.paths || [])].reverse()
        for (const p of paths) {
          this.parentPath = `/${p.file_name}${this.parentPath}`
        }
      }
    }
  }

  /** Raw cached provider metadata can seed path IDs on a new Worker instance. */
  seedFolderIds(parentPath: string, items: FileItem[]): void {
    const parent = "/" + parentPath.split("/").filter(Boolean).join("/")
    for (const item of items) {
      if (item.is_dir && /^\d+$/.test(item.sign))
        this.fidCache.set(
          `${parent === "/" ? "" : parent}/${item.name}`,
          item.sign,
        )
    }
  }

  private getRootId(): string {
    return (this.addition.root_id || "0").trim() || "0"
  }

  private toApiPath(physicalPath: string): string {
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    const rootId = this.getRootId()
    if (rootId === "0") return clean
    const rootPath = this.parentPath.replace(/\/$/, "")
    return clean === "/" ? rootPath || "/" : `${rootPath}${clean}`
  }

  private reserve(): boolean {
    if (this.budget.used >= this.budget.limit) {
      console.warn(
        `[115open] 已达 Cloudflare subrequest 预算上限(${this.budget.limit})，结果已截断`,
      )
      return false
    }
    this.budget.used++
    return true
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    this.budget.used = 0
    const cid = await this.resolveFolderId(physicalPath)
    const items: FileItem[] = []
    let offset = 0
    for (;;) {
      if (!this.reserve()) break
      const { files, count } = await this.client.getFiles({
        cid,
        limit: this.pageSize,
        offset,
        asc: this.addition.order_direction === "asc",
        o: this.addition.order_by || "file_name",
        showDir: true,
      })
      for (const f of files) {
        items.push(pan115FileToFileItem(f))
        if (f.fc === "0") {
          const parent = "/" + physicalPath.split("/").filter(Boolean).join("/")
          this.fidCache.set(`${parent === "/" ? "" : parent}/${f.fn}`, f.fid)
        }
      }
      if (items.length >= count || files.length === 0) break
      offset += files.length
    }
    return sortFileItems(
      items,
      this.addition.order_by || "file_name",
      this.addition.order_direction,
    )
  }

  /** 解析物理路径 → 文件夹 fid（逐层 getFolderInfoByPath，带缓存） */
  private async resolveFolderId(physicalPath: string): Promise<string> {
    const rootId = this.getRootId()
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    if (clean === "/" || clean === `/${rootId}`) return rootId

    const cached = this.fidCache.get(clean)
    if (cached) return cached

    // 用 GetFolderInfoByPath 一次性解析（Go Get 逻辑）
    const fullPath = this.toApiPath(clean)
    try {
      if (!this.reserve()) throw new Error("subrequest budget exceeded")
      const info = await this.client.getFolderInfoByPath(fullPath)
      if (info.file_id) {
        this.fidCache.set(clean, info.file_id)
        return info.file_id
      }
    } catch (e: any) {
      // folder/get_info 只支持目录路径：参数错误(990002)/不存在(430004) → 回退逐层
      if (e?.code !== ERR_OBJECT_NOT_FOUND && e?.code !== 990002) throw e
    }
    // 逐层解析
    const segs = clean.split("/").filter(Boolean)
    let cid = rootId
    let prefix = ""
    for (const rawSeg of segs) {
      const decodedSeg = (() => {
        try {
          return decodeURIComponent(rawSeg)
        } catch {
          return rawSeg
        }
      })()
      prefix = `${prefix}/${rawSeg}`
      const cachedId = this.fidCache.get(prefix)
      if (cachedId) {
        cid = cachedId
        continue
      }
      if (!this.reserve()) throw new Error("subrequest budget exceeded")
      const { files } = await this.client.getFiles({
        cid,
        limit: 1000,
        offset: 0,
        asc: true,
        o: "file_name",
        showDir: true,
      })
      const folder = files.find(
        (f) =>
          f.fc === "0" &&
          (f.fn === rawSeg || f.fn === decodedSeg || f.fid === rawSeg),
      )
      if (!folder) throw new Error(`folder not found: ${rawSeg}`)
      cid = folder.fid
      this.fidCache.set(prefix, cid)
    }
    return cid
  }

  /** 解析物理路径 → 文件（Go getFromParent 逻辑：列父目录匹配，拿完整 pick_code） */
  private async resolveFile(
    physicalPath: string,
    fileId?: string,
  ): Promise<Pan115File> {
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    const segs = clean.split("/").filter(Boolean)
    const rawName = segs.pop() || ""
    if (!rawName) throw new Error(`file not found: ${clean}`)
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName)
      } catch {
        return rawName
      }
    })()
    const parentPath = "/" + segs.join("/")

    const parentId = await this.resolveFolderId(parentPath)
    // Fallback: page through the parent listing when path lookup is unavailable
    // or file metadata is incomplete.
    let offset = 0
    for (;;) {
      if (!this.reserve()) throw new Error("subrequest budget exceeded")
      const { files, count } = await this.client.getFiles({
        cid: parentId,
        limit: Math.max(this.pageSize, 1000),
        offset,
        asc: true,
        o: "file_name",
        showDir: true,
      })
      const hit = fileId
        ? files.find((f) => f.fid === fileId)
        : files.find(
            (f) =>
              f.fn === rawName ||
              f.fn === decodedName ||
              f.fid === rawName ||
              f.fid === decodedName,
          )
      if (hit) return hit
      if (files.length === 0 || offset + files.length >= count) break
      offset += files.length
    }
    throw new Error(`file not found: ${rawName}`)
  }

  /** Match OpenList Go Get: resolve the full path first; list the parent only as fallback. */
  private async resolveFileByPath(
    physicalPath: string,
  ): Promise<Pan115File | null> {
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    try {
      const info = await this.client.getFolderInfoByPath(
        this.toApiPath(physicalPath),
      )
      return pan115FolderInfoToFile(info)
    } catch (e: any) {
      // The Go driver falls back to the parent listing when the object is not found.
      // 990002 is also returned by 115 for paths it cannot resolve through get_info.
      if (e?.code === ERR_OBJECT_NOT_FOUND || e?.code === 990002) return null
      throw e
    }
  }

  async get(
    _virtualPath: string,
    physicalPath: string,
    options?: DriverGetOptions,
  ): Promise<FileItem> {
    this.budget.used = 0
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    if (clean === "/" || clean === `/${this.getRootId()}`) {
      return {
        name: this.getRootId(),
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.getRootId(),
        type: 1,
        raw_url: "",
      }
    }
    let file =
      (await this.resolveFileByPath(physicalPath)) ||
      (await this.resolveFile(physicalPath))
    if (file.fc !== "0" && file.upt <= 0 && file.fid) {
      // Like Go Get, recover complete file metadata from the parent listing when
      // get_info returns a file without a usable modification timestamp.
      file = await this.resolveFile(physicalPath, file.fid)
    } else if (file.fc !== "0" && !file.pc && file.fid) {
      // Some get_info responses omit pick_code even when the file is otherwise valid.
      const listed = await this.resolveFile(physicalPath, file.fid)
      if (listed.pc) file = { ...file, pc: listed.pc }
    }
    const item = pan115FileToFileItem(file)
    if (file.fc !== "0") {
      const incomingUserAgent = options?.userAgent?.trim() || ""
      const userAgent = options?.userAgent?.trim() || OPENLIST_UA
      const userAgentSource = incomingUserAgent
        ? "incoming-request"
        : "openlist-fallback"
      const pickCode =
        file.pc ||
        (file as Pan115File & { pick_code?: string }).pick_code ||
        ""
      let linkStage = "读取文件详情"
      try {
        if (!pickCode) {
          item.raw_url_error =
            "115 文件详情未返回 pick_code，无法生成下载链接。"
          console.warn(
            `[115open] no pick_code returned for ${file.fn} (${file.fid})`,
          )
          return item
        }

        // 链接缓存（Go LinkCacheMode=UA）：同一 文件+UA 复用链接，节省 downurl 配额
        const cacheKey = `${file.fid}|${userAgent}`
        const cached = this.linkCache.get(cacheKey)
        if (cached && cached.expire > Date.now()) {
          item.raw_url = cached.url
          item.raw_url_headers = { "User-Agent": userAgent }
        } else {
          linkStage = "请求下载地址"
          if (!this.reserve()) throw new Error("subrequest budget exceeded")
          const resp = await this.client.downUrl(pickCode, userAgent)
          const entry = resp[file.fid]
          if (entry?.url?.url) {
            item.raw_url = entry.url.url
            item.raw_url_headers = { "User-Agent": userAgent }
            this.linkCache.set(cacheKey, {
              url: entry.url.url,
              expire: Date.now() + Pan115Driver.LINK_TTL_MS,
            })
          } else {
            item.raw_url_error = "115 downurl 接口未返回该文件的下载地址。"
            console.warn(
              `[115open] downurl returned no URL for ${file.fn} (${file.fid})`,
            )
          }
        }
      } catch (e: any) {
        const msg = String(e?.message || e)
        if (msg.includes("406")) {
          item.raw_url_error = "115 downurl 接口配额已用尽（code 406），请稍后重试。"
          console.warn(
            "[115open] downurl 配额用尽（406）：已使用缓存或稍后重试",
          )
        } else {
          item.raw_url_error = `${linkStage}失败：${msg}`
          console.warn("[115open] download link resolution failed", {
            stage: linkStage,
            endpoint: e?.endpoint || "/open/ufile/downurl",
            httpStatus: e?.httpStatus,
            apiCode: e?.code,
            requestId: e?.requestId || undefined,
            userAgentSource,
            sentCookieNames: e?.sentCookieNames || [],
            receivedCookieNames: e?.receivedCookieNames || [],
            message: msg,
          })
        }
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    this.budget.used = 0
    this.fidCache.clear()
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const dirName = segs.pop() || "新文件夹"
    const parentPath = "/" + segs.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    await this.client.mkdir(parentId, dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    this.budget.used = 0
    this.fidCache.clear()
    const file = await this.resolveFile(physicalPath)
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    await this.client.updateFile(file.fid, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    this.budget.used = 0
    this.fidCache.clear()
    const file = await this.resolveFile(physicalPath)
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    await this.client.delFile(file.fid, file.pid || this.getRootId())
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    this.budget.used = 0
    this.fidCache.clear()
    const file = await this.resolveFile(srcPhys)
    const dstId = await this.resolveFolderId(dstDir)
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    await this.client.move(file.fid, dstId)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    this.budget.used = 0
    this.fidCache.clear()
    const file = await this.resolveFile(srcPhys)
    const dstId = await this.resolveFolderId(dstDir)
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    await this.client.copy(dstId, file.fid)
  }

  // ---- Upload（OSS 直传：秒传 → 二次校验 → PUT Object） ----

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    if (content.length < 1) {
      throw new Error("115 网盘不允许上传空文件")
    }
    this.budget.used = 0
    this.fidCache.clear()
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const fileName = segs.pop() || "file"
    const parentPath = "/" + segs.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const target = parentId

    const fileSize = content.length
    const sha1Full = (await sha1(content)).toUpperCase()
    const preSize = Math.min(128 * 1024, fileSize)
    const sha1128k = (await sha1(content.subarray(0, preSize))).toUpperCase()

    // 1. UploadInit（秒传）
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    let initResp = await this.client.uploadInit({
      fileName,
      fileSize,
      target,
      fileId: sha1Full,
      preId: sha1128k,
    })
    if (initResp.status === 2) return // 秒传成功

    // 2. 二次校验（status 6/7/8）
    if ([6, 7, 8].includes(initResp.status) && initResp.sign_check) {
      const parts = initResp.sign_check.split("-")
      const start = parseInt(parts[0], 10)
      const end = parseInt(parts[1], 10)
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const signVal = (
          await sha1(content.subarray(start, end + 1))
        ).toUpperCase()
        if (!this.reserve()) throw new Error("subrequest budget exceeded")
        initResp = await this.client.uploadInit({
          fileName,
          fileSize,
          target,
          fileId: sha1Full,
          preId: sha1128k,
          signKey: initResp.sign_key,
          signVal,
        })
        if (initResp.status === 2) return // 校验后秒传成功
      }
    }

    // 3. 获取 OSS 上传凭证
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    const token = await this.client.uploadGetToken()
    if (!initResp.bucket || !initResp.object || !token.endpoint) {
      throw new Error("115 上传初始化失败：缺少 OSS 上传信息")
    }

    // 4. OSS PUT Object（单请求上传，含 V1 签名）
    await this.ossPutObject(token, initResp, content)
  }

  private async ossPutObject(
    token: {
      endpoint: string
      AccessKeyId: string
      AccessKeySecret: string
      SecurityToken: string
    },
    initResp: { bucket: string; object: string; callback: any },
    content: Buffer,
  ): Promise<void> {
    const endpoint = token.endpoint.startsWith("http")
      ? token.endpoint
      : `https://${token.endpoint}`
    const url = `${endpoint.replace(/\/$/, "")}/${initResp.object}`
    const cb = Buffer.from(initResp.callback?.callback || "", "utf8").toString(
      "base64",
    )
    const cbv = Buffer.from(
      initResp.callback?.callback_var || "",
      "utf8",
    ).toString("base64")

    const date = new Date().toUTCString()
    const contentType = "application/octet-stream"
    const ossHeaders = `x-oss-callback:${cb}\nx-oss-callback-var:${cbv}\nx-oss-security-token:${token.SecurityToken}\n`
    const canonicalResource = `/${initResp.bucket}/${initResp.object}`
    const stringToSign = `PUT\n\n${contentType}\n${date}\n${ossHeaders}${canonicalResource}`
    const signature = await hmacSha1Base64(stringToSign, token.AccessKeySecret)

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        Date: date,
        Authorization: `OSS ${token.AccessKeyId}:${signature}`,
        "x-oss-security-token": token.SecurityToken,
        "x-oss-callback": cb,
        "x-oss-callback-var": cbv,
        "Content-Length": String(content.length),
      },
      body: content as unknown as BodyInit,
    })
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      throw new Error(`115 OSS 上传失败（HTTP ${res.status}）：${text}`)
    }
  }
}
