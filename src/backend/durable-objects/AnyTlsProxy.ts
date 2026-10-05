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

  fetch(request: Request): Promise<Response> {
    return this.gateway.fetch(request, {
      ...this.env,
      ALLOWED_HOSTS: "proapi.115.com,passportapi.115.com",
      ANYTLS_INSECURE: "false",
    })
  }
}
