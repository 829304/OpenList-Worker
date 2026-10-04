# AnyTLS Worker 独立测试

验证云端 Worker 是否能直接连接 AnyTLS 节点，并通过节点访问 HTTPS。
不需要路由器、本机、Clash 或 Tunnel 参与运行。没有接入 OpenList 的正式 115 驱动。

这是单连接实验：未实现连接池、完整 padding 协商和复用，也未处理下载流、重试、Token 刷新和完整 Cookie 管理；不适合直接当生产代理使用。使用的第三方 TLS 库是 `@reclaimprotocol/tls@0.1.4`，正式集成前需评估其许可证和安全性。

## 配置与运行

在本目录执行 `npm install --ignore-scripts`。使用项目已安装的 Wrangler 或自己的 Wrangler。
配置项见 `.dev.vars.example`。部署到云端时用 `wrangler secret bulk /path/to/private-secrets.json` 输入同名字段；JSON 文件应放在仓库外并设为仅本人可读。
节点密码和 115 Token 都应使用 Secret。仅填节点地址不足以完成 AnyTLS 认证，还需要端口、密码、SNI 和节点所用 ALPN。

`ANYTLS_INSECURE=false` 会验证节点证书。`true` 对应订阅的 `skip-cert-verify`，只影响外层节点 TLS；目标网站的 HTTPS 校验始终开启。此次成功的香港节点测试使用 `false`。

`TEST_TOKEN` 必填。所有接口都要求 `Authorization: Bearer <TEST_TOKEN>`：

- `GET /trace`：固定访问 `https://www.cloudflare.com/cdn-cgi/trace`，仅返回出口 IP、地区和 TLS 验证结果。
- `POST /115`：经 AnyTLS 查询固定文件 `/media/script/converted_tree.txt`，再获取下载地址；不返回 Token 或下载地址。
- `POST /115-direct`：同一 Worker 使用原生 `fetch` 做相同查询，作为对照。

不接受自定义目标 URL，未授权请求直接返回 401。实验结束后删除临时 Worker，清理测试用 Secret。

## 2026-10-04 云端实测

同一个独立 Worker、同一个有效 Access Token、同一个文件的对照结果：

| 请求方式 | 文件信息接口 | 下载地址接口 | 返回下载 URL |
| --- | --- | --- | --- |
| Cloudflare 原生 fetch | state=true / code=0 | state=false / code=590031 | 否 |
| Worker 直接连接香港 AnyTLS | state=true / code=0 | state=true / code=0 | 是 |

公开 HTTPS 出口检测返回 HK / HKG，HTTP 200。节点及目标网站的 TLS 证书校验都开启。
完整脱敏结果见 `result.json`；其中 `ok` 只表示测试流程结束，应同时查看 115 的 `state/code`。
测试验证到获取下载 URL，没有请求文件内容，也没有改动正式 115 驱动。临时云端 Worker 和测试域名已在实验完成后删除。
这支持“改变出口路径可以恢复接口访问”的判断；错误码本身不能单独证明 115 的风控原因。

## 实现说明

外层 TLS 连接 AnyTLS 节点，认证后使用 AnyTLS 帧传输内层 TLS 数据；内层 TLS 验证真正目标网站的证书，然后发送 HTTP 请求。
Workers 的 `fetch` 没有原生 AnyTLS 代理参数，所以本实验使用 `cloudflare:sockets` 和 JS TLS 库来实现这条链路。

参考：[Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)、[AnyTLS 协议](https://github.com/anytls/anytls-go/blob/main/docs/protocol.md)、[TLS 库](https://github.com/reclaimprotocol/tls)。
