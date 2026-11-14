import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class NotServedBy extends Data.TaggedError("NotServedBy")<{
  expected: string;
  actual: unknown;
}> {}

interface Served {
  worker: string;
  url: string;
}

/** A Worker that reports its own name and the URL it saw. */
const echo = (worker: string) => `export default {
  async fetch(request) {
    return Response.json({ worker: "${worker}", url: request.url });
  },
};`;

/**
 * GET `url` until the named Worker answers — routing changes land as the
 * edge router restarts, so the first requests may still see the old table.
 */
const expectServedBy = (url: string, worker: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((body) => body as unknown as Served | null),
      Effect.flatMap((body) =>
        body?.worker === worker
          ? Effect.succeed(body)
          : Effect.fail(new NotServedBy({ expected: worker, actual: body })),
      ),
      Effect.retry({
        schedule: Schedule.max([Schedule.spaced("250 millis"), Schedule.recurs(40)]),
      }),
    );
  }).pipe(Effect.orDie);

const HOST = "api.alchemy-edge.test";

test.provider(
  "zone routes federate one hostname across Workers without a gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (options: { usersRoute: boolean }) =>
        stack.deploy(
          Effect.gen(function* () {
            // The custom-domain Worker serves every path no route claims.
            const api = yield* Cloudflare.Worker("EdgeApi", {
              script: echo("api"),
              domain: HOST,
            });
            const users = yield* Cloudflare.Worker("EdgeUsers", {
              script: echo("users"),
              routes: options.usersRoute ? [{ pattern: `${HOST}/users/*` }] : [],
            });
            const orders = yield* Cloudflare.Worker("EdgeOrders", {
              script: echo("orders"),
            });
            // A standalone route resource targets the same hostname.
            const ordersRoute = yield* Cloudflare.Workers.WorkerRoute("EdgeOrdersRoute", {
              zoneId: "edge-test-zone",
              pattern: `${HOST}/orders/*`,
              script: orders.workerName,
            });
            // No script: Workers are disabled here, so the request falls
            // through to the custom domain.
            yield* Cloudflare.Workers.WorkerRoute("EdgeUsersHealthBypass", {
              zoneId: "edge-test-zone",
              pattern: `${HOST}/users/health`,
            });
            return { api, users, ordersRoute };
          }),
        );

      const v1 = yield* deploy({ usersRoute: true });
      const api = v1.api.url!;
      expect(api).toMatch(/^http:\/\/localhost:\d+$/);
      // The route resource reports the hostname's edge listener.
      expect(v1.ordersRoute.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(v1.ordersRoute.routeId).toMatch(/^dev:/);
      expect(v1.users.routes).toEqual([
        expect.objectContaining({ pattern: `${HOST}/users/*`, url: v1.ordersRoute.url }),
      ]);

      // One URL, three Workers.
      expect((yield* expectServedBy(`${api}/`, "api")).url).toBe(`${api}/`);
      const user = yield* expectServedBy(`${api}/users/42?expand=true`, "users");
      // The routed Worker sees the original request URL — no gateway rewrite.
      expect(user.url).toBe(`${api}/users/42?expand=true`);
      yield* expectServedBy(`${api}/orders/7`, "orders");
      // `/users` itself is not under `/users/*`.
      yield* expectServedBy(`${api}/users`, "api");
      // The more specific opt-out route beats `/users/*`.
      yield* expectServedBy(`${api}/users/health`, "api");

      // The edge listener applies the same table.
      yield* expectServedBy(`${v1.ordersRoute.url}/users/1`, "users");
      yield* expectServedBy(`${v1.ordersRoute.url}/`, "api");

      // Removing the route hands `/users/*` back to the custom domain.
      yield* deploy({ usersRoute: false });
      yield* expectServedBy(`${api}/users/42`, "api");
      yield* expectServedBy(`${api}/orders/7`, "orders");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 120_000,
  },
);

test.provider(
  "a routes-only hostname is served on its own edge listener",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { users } = yield* stack.deploy(
        Effect.gen(function* () {
          const users = yield* Cloudflare.Worker("EdgeOnlyUsers", {
            script: echo("users"),
            routes: [{ pattern: "only.alchemy-edge.test/users/*" }],
          });
          return { users };
        }),
      );

      const url = users.routes[0]!.url!;
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);
      yield* expectServedBy(`${url}/users/1`, "users");

      // Unmatched paths have no origin in dev.
      const client = yield* HttpClient.HttpClient;
      const miss = yield* client.get(`${url}/elsewhere`);
      expect(miss.status).toBe(404);
      expect(yield* miss.text).toContain(
        "No Worker route matches only.alchemy-edge.test/elsewhere",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 120_000,
  },
);
