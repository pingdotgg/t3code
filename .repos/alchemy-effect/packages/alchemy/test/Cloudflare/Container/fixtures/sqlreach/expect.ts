import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

/**
 * Drive the sqlreach probe image: DATABASE_URL is a single rewritten-or-cloud
 * value, and a TCP connect from inside the container succeeds.
 */
export const expectDatabaseReachable = (
  baseUrl: string,
  assertHost: (hostname: string, url: URL) => void,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const get = (path: string) =>
      client.get(new URL(path, baseUrl)).pipe(
        Effect.flatMap((r) =>
          r.status !== 200
            ? Effect.fail(new Error(`not ready: ${r.status}`))
            : r.text,
        ),
        Effect.timeout("30 seconds"),
        Effect.retry({ schedule: readinessSchedule, times: 30 }),
      );

    const env = JSON.parse(yield* get("/env")) as {
      DATABASE_URL: string;
      databaseUrlCount?: number;
    };
    const databaseUrl = new URL(env.DATABASE_URL);
    assertHost(databaseUrl.hostname, databaseUrl);
    if (env.databaseUrlCount !== undefined) {
      expect(env.databaseUrlCount).toBe(1);
    }

    const probe = JSON.parse(yield* get("/probe")) as {
      ok?: boolean;
      host?: string;
      error?: string;
    };
    expect(probe.error).toBeUndefined();
    expect(probe.ok).toBe(true);
    expect(probe.host).toBe(databaseUrl.hostname);
  });
