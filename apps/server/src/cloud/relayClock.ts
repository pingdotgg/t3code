import { clockSkewFromDateHeader } from "@t3tools/shared/clockSkew";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * Seconds this machine's clock is off from the relay's when that is enough to
 * break T3 Connect, `null` when it is close enough or the relay cannot be
 * reached. Any relay response carries its time, so the request needs no auth.
 */
export const checkRelayClock = (relayUrl: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(HttpClientRequest.head(`${relayUrl}/`));
    return clockSkewFromDateHeader(response.headers.date, yield* Clock.currentTimeMillis);
  }).pipe(
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => null),
  );
