declare module "cloudflare:sockets" {
  export function connect(
    address: { hostname: string; port: number },
    options?: { secureTransport?: "off" | "on" | "starttls" },
  ): any
}
declare module "cloudflare:workers" {
  export class DurableObject<Env = any> {
    protected env: Env
    constructor(ctx: any, env: Env)
  }
}
