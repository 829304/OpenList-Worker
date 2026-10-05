import { connect } from "cloudflare:sockets"
import { DurableObject } from "cloudflare:workers"
import { createGateway } from "../anytls/handler.js"

/** Only reachable through an internal binding, never an OpenList HTTP route. */
export class AnyTlsProxy extends DurableObject {
  private gateway = createGateway({
    connect,
    reuseSessions: true,
    trusted: true,
  })

  async fetch(request: Request): Promise<Response> {
    const started = Date.now()
    const response = await this.gateway.fetch(request, {
      ...this.env,
      ALLOWED_HOSTS: "proapi.115.com,passportapi.115.com",
      ANYTLS_INSECURE: "false",
    })
    console.info(
      JSON.stringify({
        event: "115_proxy_timing",
        status: response.status,
        elapsedMs: Date.now() - started,
        connection: response.headers.get("X-OpenList-Gateway-Connection"),
        nodeConnection: response.headers.get(
          "X-OpenList-Gateway-Node-Connection",
        ),
        tls: response.headers.get("X-OpenList-Gateway-TLS"),
        timing: response.headers.get("Server-Timing"),
      }),
    )
    return response
  }
}
