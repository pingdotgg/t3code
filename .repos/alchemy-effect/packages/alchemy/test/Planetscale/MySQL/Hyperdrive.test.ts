import * as Cloudflare from "@/Cloudflare";
import * as Planetscale from "@/Planetscale";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import MySQLHyperdriveWorker from "./fixtures/hyperdrive-worker.ts";
import type { Widget } from "./fixtures/schema.ts";
import { Hyperdrive, PlanetscaleDb } from "./fixtures/Stack.ts";

const providers = Layer.mergeAll(
  Cloudflare.providers(),
  Planetscale.providers(),
);

const { test } = Test.make({
  providers,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

const fetchReady = (req: Effect.Effect<any, any, any>) =>
  req.pipe(
    Effect.flatMap((res: any) =>
      res.status >= 200 && res.status < 300
        ? res.text.pipe(Effect.as(res))
        : res.text.pipe(
            Effect.flatMap((body: string) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e: unknown): e is WorkerNotReady =>
        e instanceof WorkerNotReady && e.status >= 400 && e.status < 600,
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(20),
      ]),
    }),
  ) as Effect.Effect<HttpClientResponse>;

const expectWidgetRoundTrip = (baseUrl: string, widget: Widget) =>
  Effect.gen(function* () {
    const initial = yield* fetchReady(HttpClient.get(`${baseUrl}/widgets`));
    expect(initial.status).toBe(200);
    const initialBody = (yield* initial.json) as { widgets: Widget[] };
    expect(Array.isArray(initialBody.widgets)).toBe(true);

    const insertRes = yield* fetchReady(
      HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/widgets`).pipe(
          HttpClientRequest.bodyJsonUnsafe(widget),
        ),
      ),
    );
    expect(insertRes.status).toBe(200);
    const insertBody = (yield* insertRes.json) as { widget: Widget };
    expect(insertBody.widget).toMatchObject(widget);

    const after = yield* fetchReady(HttpClient.get(`${baseUrl}/widgets`));
    expect(after.status).toBe(200);
    const afterBody = (yield* after.json) as { widgets: Widget[] };
    expect(afterBody.widgets.some((w) => w.id === widget.id)).toBe(true);

    const deleteRes = yield* fetchReady(
      HttpClient.execute(
        HttpClientRequest.delete(`${baseUrl}/widgets/${widget.id}`),
      ),
    );
    expect(deleteRes.status).toBe(200);

    const final = yield* fetchReady(HttpClient.get(`${baseUrl}/widgets`));
    const finalBody = (yield* final.json) as { widgets: Widget[] };
    expect(finalBody.widgets.some((w) => w.id === widget.id)).toBe(false);
  });

describe.skipIf(!process.env.PLANETSCALE_TEST).sequential("Hyperdrive", () => {
  /**
   * End-to-end: deploy a {@link Planetscale.MySQLDatabase} + branch (which
   * applies the fixture migrations) + password, point a
   * {@link Cloudflare.Hyperdrive.Connection} at the password's origin, and
   * exercise the Drizzle Effect MySQL client over real MySQL via a Worker.
   *
   * Validates that:
   *   - migrations applied from the fixtures dir produce the expected table
   *   - `Cloudflare.Hyperdrive.Connect(...) + Drizzle.MySQL(...)` produces
   *     a working Effect-native client at runtime (text protocol +
   *     eval-free row parsers by default on workerd)
   *   - INSERT / SELECT / DELETE round-trip through Hyperdrive to PlanetScale
   */
  test.provider(
    "MySQLBranch + Hyperdrive + Drizzle round-trips through a Worker",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { hyperdrive, worker } = yield* stack.deploy(
          Effect.gen(function* () {
            yield* PlanetscaleDb;
            const hyperdrive = yield* Hyperdrive;
            const worker = yield* MySQLHyperdriveWorker;
            return { hyperdrive, worker };
          }),
        );

        expect(worker.url).toBeTypeOf("string");
        expect(hyperdrive.origin).toMatchObject({ port: 3306 });
        const baseUrl = (worker.url as string).replace(/\/+$/, "");
        yield* expectWidgetRoundTrip(baseUrl, { id: 1, name: "alpha" });

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 900_000 },
  );
});
