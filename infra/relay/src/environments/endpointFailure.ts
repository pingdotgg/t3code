import type { RelayEnvironmentEndpointFailure } from "@t3tools/contracts/relay";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClientError from "effect/http/HttpClientError";

export interface EndpointFailureDiagnosis {
  readonly endpointFailure: RelayEnvironmentEndpointFailure;
  readonly endpointStatus?: number;
}

/**
 * Cloudflare answers a Worker subrequest it cannot route with a plain-text body
 * such as `error code: 1033`. 1033 means no cloudflared connector is running for
 * the tunnel; 1016 means the origin hostname did not resolve.
 */
export function classifyEndpointResponse(
  status: number,
  body: string,
): RelayEnvironmentEndpointFailure {
  const cloudflareCode = /error code:\s*(\d{4})/i.exec(body)?.[1];
  if (cloudflareCode === "1016") return "dns";
  if (cloudflareCode === "1033") return "tunnel_down";
  switch (status) {
    case 530:
      return cloudflareCode === undefined ? "tunnel_down" : "unknown";
    // cloudflared answers 502 when nothing listens on the local origin port.
    case 502:
    case 503:
      return "origin_unreachable";
    case 521:
      return "refused";
    case 504:
    case 522:
    case 524:
      return "timeout";
    case 525:
    case 526:
      return "tls";
    default:
      // Any other status came from T3 Code itself, in a shape we did not expect.
      return "invalid_response";
  }
}

/** Reads the error code from the transport failure's cause chain, such as undici's `ECONNREFUSED`. */
export function classifyTransportFailure(cause: unknown): RelayEnvironmentEndpointFailure {
  const parts: Array<string> = [];
  for (let current = cause, depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = "code" in current ? current.code : undefined;
    parts.push(current.message, typeof code === "string" ? code : "");
    current = current.cause;
  }
  const text = parts.join(" ");
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|\bDNS\b/i.test(text)) return "dns";
  if (/ECONNREFUSED|refused/i.test(text)) return "refused";
  if (/CERT|\bTLS\b|\bSSL\b|certificate/i.test(text)) return "tls";
  if (/ETIMEDOUT|TIMEOUT|timed out/i.test(text)) return "timeout";
  return "unknown";
}

const ERROR_BODY_READ_TIMEOUT = Duration.seconds(2);

/** Turns a failed environment request into the cause the client shows the user. */
export const diagnoseEndpointFailure = Effect.fnUntraced(function* (cause: unknown) {
  if (!HttpClientError.isHttpClientError(cause)) {
    return { endpointFailure: "invalid_response" } satisfies EndpointFailureDiagnosis;
  }
  const response = cause.response;
  if (response === undefined) {
    return {
      endpointFailure:
        cause.reason._tag === "TransportError"
          ? classifyTransportFailure(cause.reason.cause)
          : "unknown",
    } satisfies EndpointFailureDiagnosis;
  }
  // Only Cloudflare's 530 needs the body to tell a dead tunnel from a DNS error.
  const body =
    response.status === 530
      ? Option.getOrElse(
          yield* response.text.pipe(
            Effect.timeoutOption(ERROR_BODY_READ_TIMEOUT),
            Effect.orElseSucceed(() => Option.none<string>()),
          ),
          () => "",
        )
      : "";
  return {
    endpointFailure: classifyEndpointResponse(response.status, body),
    endpointStatus: response.status,
  } satisfies EndpointFailureDiagnosis;
});
