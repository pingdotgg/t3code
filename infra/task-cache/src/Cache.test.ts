import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { Deadline } from "../vendor/vite-plus-remote-cache-cloudflare/src/streams.ts";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { Observations } from "../vendor/vite-plus-remote-cache-cloudflare/src/observations.ts";
import * as Admission from "./Admission.ts";
import * as Cache from "./Cache.ts";
import * as Savings from "./Savings.ts";

vi.mock("../vendor/vite-plus-remote-cache-cloudflare/src/database.ts", () => ({
  getScope: async () => ({}),
  selectBlob: async () => ({ blob_object: "artifact", blob_size: 4 }),
  cleanup: async () => {},
}));

it.effect("includes successful blob downloads in exported R2 usage", () =>
  Effect.gen(function* () {
    const get = vi.fn(async () => ({ size: 4, body: new Blob(["data"]).stream() }));
    const bindings = {
      developerKeys: JSON.stringify({
        julius: "210eb3d2c67a7207923e1999751300a87a2dd22839b258b80c3d805a6fe64984",
      }),
      ARTIFACTS: { get },
      readLimit: { limit: async () => ({ success: true }) },
    } as unknown as Cache.Bindings["Service"];
    using observations = vi.spyOn(Observations.prototype, "toJSON");
    const response = yield* Effect.gen(function* () {
      const cache = yield* Cache.Cache;
      return yield* cache.handle(
        new Request(
          "https://cache.example/projects/t3code/blob/12345678-1234-1234-1234-123456789abc",
          {
            headers: {
              authorization: `Basic ${btoa("julius:fixture-token-012345678901234567890123456789")}`,
            },
          },
        ),
        { waitUntil: () => {} },
      );
    }).pipe(
      Effect.provide(
        Cache.layer.pipe(
          Layer.provide([
            Layer.succeed(Cache.Bindings, bindings),
            Admission.layer,
            Layer.succeed(Savings.Savings, {
              record: () => Effect.void,
              emitTotals: () => Effect.void,
              cleanup: Effect.void,
            }),
          ]),
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toBe("data");
    expect(get).toHaveBeenCalledWith("artifact");
    expect(observations.mock.results.at(-1)?.value.r2_operations).toBe(1);
  }),
);

it.effect("aborts the upstream deadline before disposing it on interruption", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled: boolean[] = [];
    const originalDispose = Deadline.prototype.dispose;
    using _dispose = vi.spyOn(Deadline.prototype, "dispose").mockImplementation(function (
      this: Deadline,
    ) {
      try {
        this.check();
        cancelled.push(false);
      } catch {
        cancelled.push(true);
      }
      originalDispose.call(this);
    });
    const bindings = {
      developerKeys: JSON.stringify({
        julius: "210eb3d2c67a7207923e1999751300a87a2dd22839b258b80c3d805a6fe64984",
      }),
      ARTIFACTS: {
        get: () => {
          Deferred.doneUnsafe(entered, Effect.void);
          return new Promise(() => {});
        },
      },
      readLimit: { limit: async () => ({ success: true }) },
    } as unknown as Cache.Bindings["Service"];
    yield* Effect.gen(function* () {
      const cache = yield* Cache.Cache;
      const fiber = yield* cache
        .handle(
          new Request(
            "https://cache.example/projects/t3code/blob/12345678-1234-1234-1234-123456789abc",
            {
              headers: {
                authorization: `Basic ${btoa("julius:fixture-token-012345678901234567890123456789")}`,
              },
            },
          ),
          { waitUntil: () => {} },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(cancelled).toEqual([true]);
    }).pipe(
      Effect.provide(
        Cache.layer.pipe(
          Layer.provide([
            Layer.succeed(Cache.Bindings, bindings),
            Admission.layer,
            Layer.succeed(Savings.Savings, {
              record: () => Effect.void,
              emitTotals: () => Effect.void,
              cleanup: Effect.void,
            }),
          ]),
        ),
      ),
    );
  }),
);

it.effect("does not charge authenticated budgets for anonymous or malformed requests", () => {
  const limit = vi.fn(async (_options: { key: string }) => ({ success: true }));
  return Effect.gen(function* () {
    const cache = yield* Cache.Cache;
    for (const operation of [
      "fetch",
      "store",
      "telemetry",
      "blob/12345678-1234-1234-1234-123456789abc",
    ]) {
      for (const method of ["GET", "POST"]) {
        yield* cache.handle(
          new Request(`https://cache.example/projects/t3code/${operation}`, { method }),
          { waitUntil: () => {} },
        );
      }
    }
    expect(limit).not.toHaveBeenCalled();
    const headers = {
      authorization: `Basic ${btoa("julius:fixture-token-012345678901234567890123456789")}`,
    };
    yield* cache.handle(
      new Request("https://cache.example/projects/t3code/telemetry", {
        method: "POST",
        headers,
        body: "{}",
      }),
      { waitUntil: () => {} },
    );
    yield* cache.handle(
      new Request(
        "https://cache.example/projects/t3code/blob/12345678-1234-1234-1234-123456789abc",
        { headers },
      ),
      { waitUntil: () => {} },
    );
    expect(limit.mock.calls).toEqual([[{ key: "t3code:telemetry" }], [{ key: "t3code:blob" }]]);
  }).pipe(
    Effect.provide(
      Cache.layer.pipe(
        Layer.provide([
          Layer.succeed(Cache.Bindings, {
            developerKeys: JSON.stringify({
              julius: "210eb3d2c67a7207923e1999751300a87a2dd22839b258b80c3d805a6fe64984",
            }),
            readerKeys: "{}",
            readLimit: { limit },
            storeLimit: { limit },
            ARTIFACTS: { get: async () => ({ size: 4, body: new Blob(["data"]).stream() }) },
          } as unknown as Cache.Bindings["Service"]),
          Admission.layer,
          Layer.succeed(Savings.Savings, {
            record: () => Effect.void,
            emitTotals: () => Effect.void,
            cleanup: Effect.void,
          }),
        ]),
      ),
    ),
  );
});

it.effect("authenticates setup probes without recording empty savings", () => {
  const record = vi.fn(() => Effect.void);
  const emitTotals = vi.fn(() => Effect.void);
  return Effect.gen(function* () {
    const cache = yield* Cache.Cache;
    const response = yield* cache.handle(
      new Request("https://cache.example/projects/t3code/telemetry", {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa("julius:fixture-token-012345678901234567890123456789")}`,
        },
        body: JSON.stringify({
          id: "a".repeat(64),
          recordedAt: 0,
          host: "setup-host",
          platform: "linux",
          arch: "x64",
          ci: false,
          runId: "setup",
          tasks: [],
        }),
      }),
      { waitUntil: () => {} },
    );
    expect(response.status).toBe(204);
    expect(record).not.toHaveBeenCalled();
    expect(emitTotals).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      Cache.layer.pipe(
        Layer.provide([
          Layer.succeed(Cache.Bindings, {
            developerKeys: JSON.stringify({
              julius: "210eb3d2c67a7207923e1999751300a87a2dd22839b258b80c3d805a6fe64984",
            }),
            readLimit: { limit: async () => ({ success: true }) },
          } as unknown as Cache.Bindings["Service"]),
          Admission.layer,
          Layer.succeed(Savings.Savings, { record, emitTotals, cleanup: Effect.void }),
        ]),
      ),
    ),
  );
});

it.effect("keeps artifacts private and limits CI reader credentials to reads", () =>
  Effect.gen(function* () {
    const cache = yield* Cache.Cache;
    const context = { waitUntil: () => {} };
    const blob = "https://cache.example/projects/t3code/blob/12345678-1234-1234-1234-123456789abc";
    for (const url of [blob, "https://cache.example/projects/t3code/fetch"]) {
      const method = url === blob ? "GET" : "POST";
      expect((yield* cache.handle(new Request(url, { method }), context)).status).toBe(401);
      expect(
        (yield* cache.handle(
          new Request(url, {
            method,
            headers: { authorization: `Basic ${btoa("ci-reader:wrong")}` },
          }),
          context,
        )).status,
      ).toBe(403);
    }
    const headers = {
      authorization: `Basic ${btoa("ci-reader:fixture-token-012345678901234567890123456789")}`,
    };
    expect((yield* cache.handle(new Request(blob, { headers }), context)).status).toBe(200);
    expect(
      (yield* cache.handle(
        new Request("https://cache.example/projects/t3code/store", { method: "POST", headers }),
        context,
      )).status,
    ).toBe(403);
  }).pipe(
    Effect.provide(
      Cache.layer.pipe(
        Layer.provide([
          Layer.succeed(Cache.Bindings, {
            developerKeys: "{}",
            readerKeys: JSON.stringify({
              "ci-reader": "210eb3d2c67a7207923e1999751300a87a2dd22839b258b80c3d805a6fe64984",
            }),
            ARTIFACTS: { get: vi.fn(async () => ({ size: 4, body: new Blob(["data"]).stream() })) },
            readLimit: { limit: async () => ({ success: true }) },
            storeLimit: { limit: async () => ({ success: true }) },
          } as unknown as Cache.Bindings["Service"]),
          Admission.layer,
          Layer.succeed(Savings.Savings, {
            record: () => Effect.void,
            emitTotals: () => Effect.void,
            cleanup: Effect.void,
          }),
        ]),
      ),
    ),
  ),
);

it.effect("rejects anonymous and invalid Basic requests before admission", () =>
  Effect.gen(function* () {
    const cache = yield* Cache.Cache;
    for (const operation of ["store", "telemetry", "fetch"]) {
      for (const authorization of [undefined, `Basic ${btoa("attacker:invalid")}`]) {
        const response = yield* cache.handle(
          new Request(`https://cache.example/projects/t3code/${operation}`, {
            method: "POST",
            headers: authorization ? { authorization } : {},
          }),
          { waitUntil: () => {} },
        );
        expect(response.status).toBe(authorization ? 403 : 401);
      }
    }
  }).pipe(
    Effect.provide(
      Cache.layer.pipe(
        Layer.provide([
          Layer.succeed(Cache.Bindings, {
            developerKeys: "{}",
            readerKeys: "{}",
          } as Cache.Bindings["Service"]),
          Layer.succeed(Admission.Admission, {
            withPermit: () => Effect.die("Unauthenticated request reached admission"),
          }),
          Layer.succeed(Savings.Savings, {
            record: () => Effect.void,
            emitTotals: () => Effect.void,
            cleanup: Effect.void,
          }),
        ]),
      ),
    ),
  ),
);
