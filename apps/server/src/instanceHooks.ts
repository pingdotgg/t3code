import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  ServerStopHookInvalidUrlError,
  ServerStopHookNotConfiguredError,
  ServerStopHookRequestError,
  ServerStopHookUnexpectedStatusError,
  type ServerStopHookResult,
} from "@t3tools/contracts";

import * as ServerSettings from "./serverSettings.ts";

const STOP_HOOK_TIMEOUT = "20 seconds";

/** Null when the hook is a dialable http(s) URL, otherwise the rejection. */
function rejectNonHttpUrl(url: string): ServerStopHookInvalidUrlError | null {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return new ServerStopHookInvalidUrlError({ protocol: null });
  }
  return protocol === "http:" || protocol === "https:"
    ? null
    : new ServerStopHookInvalidUrlError({ protocol });
}

/**
 * Run the configured stop hook: DELETE the management endpoint that stops
 * this instance. A 204 reports the instance as stopping. A 404 means the
 * hook no longer exists, so the setting is cleared and clients drop their
 * stop controls with it.
 */
export const runStopHook = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const stopHookUrl = (yield* serverSettings.getSettings).stopHookUrl;
  if (stopHookUrl === null) {
    return yield* new ServerStopHookNotConfiguredError({});
  }
  const invalidUrl = rejectNonHttpUrl(stopHookUrl);
  if (invalidUrl !== null) {
    return yield* invalidUrl;
  }
  const response = yield* httpClient.execute(HttpClientRequest.delete(stopHookUrl)).pipe(
    Effect.timeout(STOP_HOOK_TIMEOUT),
    Effect.mapError((error) => new ServerStopHookRequestError({ cause: error })),
  );
  if (response.status === 204) {
    return { outcome: "stopped" } satisfies ServerStopHookResult;
  }
  if (response.status === 404) {
    // Re-read before clearing: only forget the hook that actually returned
    // the 404, not one reconfigured while the request was in flight.
    if ((yield* serverSettings.getSettings).stopHookUrl === stopHookUrl) {
      yield* serverSettings.updateSettings({ stopHookUrl: null });
    }
    return { outcome: "gone" } satisfies ServerStopHookResult;
  }
  return yield* new ServerStopHookUnexpectedStatusError({ status: response.status });
});
