# 115 AnyTLS 网关

独立 Cloudflare Worker，通过指定的 AnyTLS 节点发送 HTTPS 请求。OpenList 的 115 Open 存储可用它访问 API、刷新 Token 和流式下载文件。节点地址和密码使用 Worker Secrets 保存，浏览器不会收到网关密钥。

## 部署

```sh
cd gateway/anytls
npm ci
npm test
npm run build
```

修改 `wrangler.jsonc` 中的 Worker 名称，并按需添加自己的自定义域名。用 Wrangler 的 `secret put` 或控制台设置以下 Secrets：

| Secret | 内容 |
| --- | --- |
| `ANYTLS_SERVER` | 节点域名或 IP |
| `ANYTLS_PORT` | 节点端口 |
| `ANYTLS_SNI` | 节点 TLS 的 servername，通常与域名一致 |
| `ANYTLS_PASSWORD` | AnyTLS 节点密码 |
| `GATEWAY_TOKEN` | 随机网关密钥，至少 16 个字符；建议 `openssl rand -hex 32` |

然后运行 `wrangler deploy`。此项目已部署到 `https://115-gateway.829304.xyz`，使用订阅中的香港 01 节点；仓库没有保存该节点的凭据或订阅地址。

## GitHub Actions 自动部署

仓库的 `Deploy to Cloudflare Workers` 工作流会先构建、测试并部署本网关，再部署 OpenList。推送 `main` 且修改 `gateway/anytls/**` 或原有 OpenList 部署文件时会自动触发，也可在 Actions 页面手动运行。

使用现有的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 和 `ADMIN_PASS` GitHub Secrets。节点凭据及 `GATEWAY_TOKEN` 保存在 Cloudflare 的 `openlist-anytls-gateway` Worker Secrets 中，代码部署会保留它们，不需要把订阅或节点密码再复制到 GitHub。当前已配置的香港节点可直接使用。

部署到新账户或新 Worker 名称时，须先按上表配置 Cloudflare Secrets，并修改两个 Worker 的自定义域名；工作流不会自动从订阅获取节点或生成网关密钥。节点密码变化后更新 Cloudflare Secrets；`GATEWAY_TOKEN` 变化时还需同步 OpenList 存储中的代理密钥。

默认验证节点与 115 的 TLS 证书。`ANYTLS_ALPN` 是节点 ALPN 的 JSON 数组。`ANYTLS_INSECURE=true` 仅关闭节点证书验证，不影响目标网站的证书验证。

## OpenList 配置

在「管理 → 存储 → 编辑 115 Open」填写：

- **API 代理地址**：网关的 HTTPS 根地址，例如 `https://115-gateway.829304.xyz`。
- **API 代理密钥**：对应的 `GATEWAY_TOKEN`。

保存后该存储的 API、Token 刷新、文件下载都走同一网关。地址留空时使用原来的直连方式。填写代理但代理故障时会返回错误，避免请求自动切回 Cloudflare 出口。其他存储不受影响。

如需客户端 Range 分段下载，保持存储的「代理 Range」开启。节点凭据变化后更新网关 Secrets 即可；切换节点后应重新取得下载链接，因为 115 链接可能绑定出口 IP。

## 接口与限制

所有接口要求 `Authorization: Bearer <GATEWAY_TOKEN>`。`GET /health` 仅检查接口鉴权，不测试节点连通性。`POST /v1/request` 接受以下 JSON：

```json
{
  "url": "https://proapi.115.com/open/user/info",
  "method": "GET",
  "headers": [["Authorization", "Bearer <115 access token>"]],
  "body": null
}
```

默认只允许 `proapi.115.com`、`passportapi.115.com` 和 `*.115cdn.net` 的 HTTPS 443 端口，请求方法为 GET、POST、HEAD。请求体上限 512 KiB；响应流式传输，支持 Content-Length、chunked、Range。OpenList 检查重定向并逐次重新请求，网关不自动跟随重定向。

入口 Worker 仅鉴权和转发；使用固定 4 个 SQLite Durable Object 执行 AnyTLS/TLS 及响应流处理，复用执行器内的证书信任库解析缓存，不写入持久化数据。这样避免免费 Worker 的 10 毫秒 CPU 上限导致间歇性空 503；Durable Object 默认每次调用的 CPU 上限为 30 秒，并可在免费套餐使用。配置中的 `ANYTLS_SESSIONS` 绑定和 SQLite migration 会在部署时自动创建，Secrets 仍属于同一网关 Worker。参见 [CPU 限制](https://developers.cloudflare.com/durable-objects/platform/limits/) 和 [免费额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

每个请求仍建立独立 AnyTLS/TLS 连接，并使用各自的协议配置，节点返回的 padding 更新不会改变其他连接。响应头阶段最长 30 秒，响应体连续空闲 60 秒会断开；仍受 Durable Object 的 CPU、请求数及计算时长额度限制。响应流结束或取消时关闭连接。已验证真实 115 文件下载；大文件吞吐和并发能力需要按实际使用量继续评估。

网关错误带 `X-OpenList-Gateway-Error: 1`，只返回阶段和通用错误，不返回节点密码或上游请求内容。真实上游响应带 `X-OpenList-Gateway-Upstream: 1`，上游的正常 HTTP 错误保留原状态码；缺少此标记的 HTTP 5xx 被 OpenList 识别为网关故障，避免把 Cloudflare 的空 503 当成 115 API 错误。

TLS 实现使用 `@reclaimprotocol/tls`；许可见 [THIRD_PARTY_LICENSES.txt](./THIRD_PARTY_LICENSES.txt)。
