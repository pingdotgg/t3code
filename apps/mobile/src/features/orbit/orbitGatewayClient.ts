import {
  createOrbitGatewayClient,
  DEFAULT_ORBIT_GATEWAY_URL,
  orbitGatewayPathWithQuery,
  type OrbitGatewayTransport,
} from "@t3tools/client-runtime/orbit-gateway";

/** Conn: the same limit the desktop main process sets for a Gateway call without its own. */
export const DEFAULT_GATEWAY_TIMEOUT_MS = 15_000;

/**
 * Conn: the phone's Gateway transport. Every call ends within its `timeoutMs` (or the default), so
 * an unreachable Gateway fails the call instead of holding the refresh that the lists wait on.
 */
export function createMobileGatewayTransport(
  fetchImpl: typeof fetch,
  defaultTimeoutMs = DEFAULT_GATEWAY_TIMEOUT_MS,
): OrbitGatewayTransport {
  return async (request) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs ?? defaultTimeoutMs);
    try {
      const response = await fetchImpl(
        `${DEFAULT_ORBIT_GATEWAY_URL}/api/v1${request.root === true ? "" : "/conn"}${orbitGatewayPathWithQuery(request)}`,
        {
          method: request.method,
          headers: {
            Accept: "application/json",
            ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(request.idempotencyKey === undefined
              ? {}
              : { "Idempotency-Key": request.idempotencyKey }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: controller.signal,
        },
      );
      return { status: response.status, body: await response.text() };
    } catch (error) {
      if (timedOut) throw new Error("The Orbit Gateway did not answer in time.", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The Gateway knows the phone by its WireGuard address, so the calls carry no credentials. */
export const orbitGatewayTransport = createMobileGatewayTransport((input, init) =>
  fetch(input, init),
);
export const orbitGatewayClient = createOrbitGatewayClient(orbitGatewayTransport);
