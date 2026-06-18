import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

import { getHostBearerToken } from "./hostBootstrap";

export const primaryEnvironmentRequestInit = { credentials: "include" } as const;
const primaryHostBearerRequestInit = { credentials: "omit" } as const;

function isPrimaryPublicDescriptorRequest(input: RequestInfo | URL | undefined): boolean {
  if (!input) {
    return false;
  }

  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : "url" in input
          ? input.url
          : "";
  if (!rawUrl) {
    return false;
  }

  const baseUrl = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  return new URL(rawUrl, baseUrl).pathname === "/.well-known/t3/environment";
}

export function withPrimaryHostAuthorization(
  init?: RequestInit,
  input?: RequestInfo | URL,
): RequestInit {
  const bearerToken = getHostBearerToken();
  if (!bearerToken || isPrimaryPublicDescriptorRequest(input)) {
    return init ?? primaryEnvironmentRequestInit;
  }

  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${bearerToken}`);
  return {
    ...primaryHostBearerRequestInit,
    ...init,
    credentials: primaryHostBearerRequestInit.credentials,
    headers,
  };
}

export const withPrimaryEnvironmentRequestInit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, withPrimaryHostAuthorization()));
