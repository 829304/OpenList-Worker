export function createGateway(options: {
  connect: (...args: any[]) => any
  reuseSessions?: boolean
  trusted?: boolean
}): {
  fetch(request: Request, env: any): Promise<Response>
  close(): Promise<void>
}
