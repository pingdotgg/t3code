import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Binding a Cloudflare Tunnel inside an Action via `ReadWriteTunnelLocal` — the
// local (current-credentials) implementation of the `ReadWriteTunnel` binding.
// Exercises the write side (`putConfiguration`) and the read side
// (`getConfiguration`/`get`/`getToken`) against a real tunnel, plus the deferred
// `yield* tunnel.tunnelId` accessor resolved at apply time.
test.provider(
  "ReadWriteTunnelLocal: configure and read a tunnel from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const tunnel = yield* Cloudflare.Tunnel.Tunnel("LocalBindingTunnel");

          const Manage = Action(
            "Manage",
            Effect.gen(function* () {
              const tunnels = yield* Cloudflare.Tunnel.ReadWriteTunnel();
              // Accessor — resolved at apply time against the tracker.
              const tunnelId = yield* tunnel.tunnelId;

              return Effect.fn(function* () {
                const id = yield* tunnelId;

                // Write: push ingress configuration.
                yield* tunnels.putConfiguration(id, {
                  ingress: [
                    {
                      hostname: "local-binding.alchemy-test-2.us",
                      service: "http://localhost:3000",
                    },
                    { service: "http_status:404" },
                  ],
                });

                // Read back the configuration we just wrote.
                const cfg = yield* tunnels.getConfiguration(id);
                // Read the tunnel + its connector token.
                const t = yield* tunnels.get(id);
                const token = yield* tunnels.getToken(id);

                return {
                  tunnelId: id,
                  name: t.id === id ? t.name : undefined,
                  ingress: (cfg.config?.ingress ?? []).map((rule) => ({
                    hostname: rule.hostname ?? undefined,
                    service: rule.service,
                  })),
                  hasToken: typeof token === "string" && token.length > 0,
                };
              });
            }).pipe(Effect.provide(Cloudflare.Tunnel.ReadWriteTunnelLocal)),
          );

          return yield* Manage({});
        }),
      );

      expect(out.tunnelId).toBeTruthy();
      expect(out.hasToken).toBe(true);
      expect(out.ingress).toEqual([
        {
          hostname: "local-binding.alchemy-test-2.us",
          service: "http://localhost:3000",
        },
        { hostname: undefined, service: "http_status:404" },
      ]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
