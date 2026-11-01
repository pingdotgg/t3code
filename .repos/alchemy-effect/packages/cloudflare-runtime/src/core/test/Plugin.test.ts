import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Plugin from "../Plugin.ts";
import * as PluginContext from "../PluginContext.ts";
import type { RuntimeWorker } from "../RuntimeWorker.ts";
import { SERVICE_USER_WORKER } from "../internal/constants.ts";

const makeWorker = (overrides: Partial<RuntimeWorker> = {}): RuntimeWorker => ({
  name: "test",
  compatibilityDate: "2026-03-10",
  compatibilityFlags: [],
  bindings: [],
  modules: [],
  ...overrides,
});

class Greeter extends Plugin.Service<
  Greeter,
  { greet: (name: string) => string }
>()("cloudflare-runtime/plugin/Greeter") {}

const GreeterLive = Layer.succeed(
  Greeter,
  Greeter.of({
    services: [{ name: "greeter:svc" }],
    api: { greet: (name) => `hello, ${name}!` },
  }),
);

describe("Plugin / PluginContext", () => {
  it.effect("registers plugins discovered in the Effect context", () =>
    Effect.gen(function* () {
      const ctx = yield* PluginContext.make(makeWorker());
      expect(ctx.plugins.size).toBe(1);
      const greeter = yield* ctx.get(Greeter);
      expect(greeter.api.greet("world")).toBe("hello, world!");
      const config = yield* ctx.config;
      expect(config.services).toEqual([{ name: "greeter:svc" }]);
    }).pipe(Effect.provide(GreeterLive)),
  );

  it.effect("get fails with a ConfigError when a plugin is missing", () =>
    Effect.gen(function* () {
      const ctx = yield* PluginContext.make(makeWorker());
      const error = yield* ctx.get(Greeter).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ConfigError",
        subtag: "PluginNotFound",
      });
    }),
  );

  it.effect("middlewares chain into a service pipeline ending at 'user'", () =>
    Effect.gen(function* () {
      class A extends Plugin.Service<A>()("cloudflare-runtime/plugin/A") {}
      class B extends Plugin.Service<B>()("cloudflare-runtime/plugin/B") {}
      const layerA = Layer.succeed(
        A,
        A.of({
          middlewares: [
            {
              name: "mw:a",
              worker: { compatibilityDate: "2026-03-10" },
              upstreamBindingName: "NEXT",
            },
          ],
        }),
      );
      const layerB = Layer.succeed(
        B,
        B.of({
          middlewares: [
            {
              name: "mw:b",
              worker: { compatibilityDate: "2026-03-10" },
              upstreamBindingName: "NEXT",
            },
          ],
        }),
      );
      const ctx = yield* PluginContext.make(makeWorker()).pipe(
        Effect.provide(Layer.mergeAll(layerA, layerB)),
      );
      const config = yield* ctx.config;
      expect(config.entry === "mw:a" || config.entry === "mw:b").toBe(true);
      const middlewareServices = config.services.filter((s) =>
        s.name?.startsWith("mw:"),
      );
      expect(middlewareServices).toHaveLength(2);
      const lastMiddleware = middlewareServices[middlewareServices.length - 1];
      const lastBindings = (
        lastMiddleware as { worker: { bindings: Array<any> } }
      ).worker.bindings;
      const upstream = lastBindings.find((b) => b.name === "NEXT");
      expect(upstream?.service?.name).toBe(SERVICE_USER_WORKER);
    }),
  );

  it.effect("Plugin.useSync reads a plugin field synchronously", () =>
    Effect.gen(function* () {
      const ctx = yield* PluginContext.make(makeWorker());
      const greeting = yield* Plugin.useSync(Greeter, (g) =>
        g.api.greet("ctx"),
      ).pipe(Effect.provideService(PluginContext.PluginContext, ctx));
      expect(greeting).toBe("hello, ctx!");
    }).pipe(Effect.provide(GreeterLive)),
  );
});
