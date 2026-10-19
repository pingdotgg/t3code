import { clockSkewFromDateHeader } from "@t3tools/shared/clockSkew";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";

// Status also works before authorization succeeds, so this probe needs no credentials.
export const checkRelayClock = Effect.fn("cloud.checkRelayClock")(
  function* (relayUrl: string) {
    const httpClient = yield* HttpClient.HttpClient;
    const [duration, response] = yield* httpClient
      .execute(HttpClientRequest.head(`${relayUrl}/`))
      .pipe(Effect.timed);
    return clockSkewFromDateHeader(
      response.headers.date,
      yield* Clock.currentTimeMillis,
      Duration.toMillis(duration),
    );
  },
  Effect.timeout("2 seconds"),
  Effect.orElseSucceed(() => null),
);
