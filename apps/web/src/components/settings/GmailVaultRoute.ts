import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { GMAIL_CALLBACK_PATH, type EnvironmentId } from "@t3tools/contracts";
import { isPublicFaviconHost } from "@t3tools/shared/hostClassification";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { literalLoopback, privateVaultRoute, usePrivateVaultRoute } from "./privateVaultRoute";

export function parseCallback(value: string | undefined) {
  if (!value) return null;
  const url = URL.parse(value);
  if (!url || value !== `${url.origin}${GMAIL_CALLBACK_PATH}`) return null;
  return url.protocol === "https:" || (url.protocol === "http:" && literalLoopback(url))
    ? url
    : null;
}

function callbackRoute(route: { direct: boolean; origin: URL } | null, callback: URL) {
  if (!route) return null;
  if (route.direct && callback.origin === route.origin.origin) return "direct";
  // Apply the shared public-host policy to alternate origins, never to an already verified route.
  if (callback.protocol === "https:" && isPublicFaviconHost(callback.hostname)) return "probe";
  return null;
}

export function useSuggestedGmailRedirect(
  environmentId: EnvironmentId,
  advertised: string | undefined,
) {
  const route = usePrivateVaultRoute(environmentId);
  const callback = parseCallback(advertised);
  return callback && callbackRoute(route, callback) ? callback.href : null;
}

export async function canReachCallback(
  environmentId: EnvironmentId,
  callback: URL,
): Promise<boolean> {
  const route = callbackRoute(privateVaultRoute(environmentId), callback);
  if (route === "direct") return true;
  if (!route) return false;

  // Ask only for public metadata. The OAuth URL, cookies and environment auth stay out of this GET.
  return fetchRemoteEnvironmentDescriptor({ httpBaseUrl: callback.origin, timeoutMs: 4_000 }).pipe(
    Effect.map((descriptor) => descriptor.environmentId === environmentId),
    Effect.orElseSucceed(() => false),
    Effect.provideService(FetchHttpClient.RequestInit, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    }),
    Effect.provide(layerRemoteHttpClient(globalThis.fetch)),
    Effect.runPromise,
  );
}
