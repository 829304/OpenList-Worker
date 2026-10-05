# 115 内置 AnyTLS API 代理

代理随 OpenList 一起部署，通过私有 `ANYTLS_SESSIONS` Durable Object 绑定调用。它只允许访问 `proapi.115.com` 和 `passportapi.115.com` 的 HTTPS 443 API，没有公开代理路由。获取下载直链后，302 模式下播放与下载由客户端直接访问 115 CDN。

## 配置

在 OpenList Worker 的 Cloudflare Secrets 中设置以下值，勿提交订阅或节点密码：

| Secret            | 内容                                     |
| ----------------- | ---------------------------------------- |
| `ANYTLS_SERVER`   | 节点域名或 IP                            |
| `ANYTLS_PORT`     | 节点端口                                 |
| `ANYTLS_PASSWORD` | 节点密码                                 |
| `ANYTLS_SNI`      | 节点证书的域名，留空时使用节点地址       |
| `ANYTLS_ALPN`     | 可选 JSON 数组，默认 `["h2","http/1.1"]` |

节点和 115 的 TLS 证书始终验证。`wrangler.jsonc` 的 SQLite DO migration 会在部署时创建绑定；无需持久化业务数据。免费 Worker 的 10ms CPU 限制不适合执行 JavaScript TLS，代理握手保留在 DO 内。参见 [DO 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。

在「管理 → 存储 → 编辑 115 Open」开启 **内置 API 代理**。启用后无需 API 代理地址或密钥；关闭该项时仍可使用原有外部 API 网关配置，二者都未配置时直连。已启用代理的连接故障会报错，不自动切回 Cloudflare 出口。

保持 **Web 代理关闭**、**WebDAV 302 重定向**。AnyTLS 只处理 API、刷新 Token 和获取直链，不转发文件内容。直链仍受 115 的 User-Agent、有效期等条件限制。

## 连接和延迟

每个 API 主机使用稳定的 DO ID；初次创建提示 `apac`，实际位置由 Cloudflare 决定，不保证香港。连接分两层复用：

- HTTP/1.1 与到 115 的 TLS 连接复用，每个目标串行处理响应，最多排队 16 个请求，响应上限 2 MiB。
- 115 关闭连接或取消一个请求时，只关闭对应的 AnyTLS 流，保留机场 TCP/TLS 会话；下次以新流连接 115。

空闲期限 120 秒，最大会话寿命 5 分钟，活跃请求完成后才退休。连接池最多保留 4 个节点会话，每个会话最多 4 个流。不主动轮询 115 或发保活流量。失效的旧 HTTP 连接仅对 GET 重试一次；POST 不由连接池重放。认证和 Cookie 每次由调用者发送，连接池不保存账户 Cookie。节点提供的 padding 更新仅缓存给该节点后续会话。

内部响应提供以下诊断头：

- `X-OpenList-Gateway-Connection`：115 HTTP 连接 `new` / `reused`。
- `X-OpenList-Gateway-Node-Connection`：机场会话 `new` / `reused`。
- `X-OpenList-Gateway-TLS`：115 协商的 TLS 版本。
- `Server-Timing`：排队、节点 TCP/TLS、AnyTLS 认证、目标连接、目标 TLS、请求写入和响应等待。证书验证是 TLS 阶段的子项，不能与 TLS 耗时相加。AnyTLS SYN ACK 可能在服务器 TCP 建连前发出，因此 `target_connect` 与 `target_tls` 的分界是近似值。

目录浏览首次请求直接用文件 API 验证 Token，避免额外 `user/info`；显式保存存储仍验证凭据。目录缓存保存原始元数据，权限和下载签名每次重新计算。缓存父目录的原始文件夹 ID 可以在新 Worker 实例中复用，减少路径查找。缓存遵循存储 TTL，手动刷新和 OpenList 写操作会失效；从 115 客户端修改需等待 TTL 或手动刷新。Cloudflare Cache API 只在执行节点共享，不是全球缓存。

## 部署和兼容

GitHub Actions 现在只部署 OpenList，一起执行 `pnpm run test:anytls` 和 115 集成测试。节点 Secrets 由 Cloudflare 保留，无需复制到 GitHub。首次迁移先给 OpenList 配置节点 Secrets，再部署并开启存储的内置代理。确认成功后可停用旧独立网关；旧网关不再由本仓库工作流更新。

实现使用 `@reclaimprotocol/tls`，许可见 [THIRD_PARTY_LICENSES.txt](./THIRD_PARTY_LICENSES.txt)。旧独立网关入口的兼容测试仍用于检查鉴权与请求限制。
