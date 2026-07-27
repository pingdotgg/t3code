import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

describe("Tunnel Configuration", () => {
  // Canonical `list()` test (parent fan-out singleton): the configuration is a
  // per-tunnel document with no account-wide enumeration API, so `list()`
  // enumerates every cfd_tunnel in the account and reads each tunnel's config.
  // Deploy a tunnel + configuration, then assert the deployed tunnel appears in
  // the listed result.
  test.provider(
    "list enumerates configurations across all tunnels",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const tunnel = yield* Cloudflare.Tunnel.Tunnel("ListTunnel", {
              name: "alchemy-tunnel-config-list-test",
              configSrc: "cloudflare",
            });
            const config = yield* Cloudflare.Tunnel.Configuration(
              "ListConfig",
              {
                tunnelId: tunnel.tunnelId,
                ingress: [
                  {
                    hostname: "config-list-test.internal",
                    service: "http://localhost:8080",
                  },
                ],
              },
            );
            return { tunnelId: tunnel.tunnelId, config };
          }),
        );

        const provider = yield* Provider.findProvider(
          Cloudflare.Tunnel.Configuration,
        );
        const all = yield* provider.list();

        expect(all.some((c) => c.tunnelId === deployed.tunnelId)).toBe(true);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 180_000 },
  );
});
