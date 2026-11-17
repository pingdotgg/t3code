import type { OrbitGatewayTransport } from "@t3tools/client-runtime/orbit-gateway";

/** The Gateway transport over the desktop main process, or null outside the desktop app. */
export function desktopOrbitGatewayTransport(): OrbitGatewayTransport | null {
  const send = window.desktopBridge?.orbitGatewaySend;
  if (!send) return null;
  return async (request) => {
    const response = await send({
      method: request.method,
      path: request.path,
      body: request.body === undefined ? null : JSON.stringify(request.body),
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request.root === true ? { root: true as const } : {}),
    });
    if (response.error !== null) throw new Error(response.error);
    return { status: response.status, body: response.body };
  };
}
