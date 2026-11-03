import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, UsageLimitSourceError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverUpstreamCredentials,
  probeUpstreamUsage,
  type StoredUpstreamCredential,
  type UpstreamUsageReader,
} from "./upstreamUsage.ts";

const driver = ProviderDriverKind.make("codex");

describe("discoverUpstreamCredentials", () => {
  it.effect("discovers Pi api_key and OpenCode api entries from a temporary auth.json", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-upstream-usage-" });
      const authPath = path.join(dir, "auth.json");
      yield* fileSystem.writeFileString(
        authPath,
        JSON.stringify({
          pi: { type: "api_key", key: "pi-secret" },
          opencode: { type: "api", key: "opencode-secret" },
        }),
      );

      const credentials = yield* discoverUpstreamCredentials(authPath);

      expect(credentials).toEqual([
        { providerId: "pi", authType: "api_key", secret: "pi-secret" },
        { providerId: "opencode", authType: "api", secret: "opencode-secret" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("tolerates a missing auth file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-upstream-usage-" });

      const credentials = yield* discoverUpstreamCredentials(path.join(dir, "auth.json"));

      expect(credentials).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("probeUpstreamUsage", () => {
  it.effect("returns an unsupported account for a provider with no registered reader", () =>
    Effect.gen(function* () {
      const readers: Readonly<Record<string, UpstreamUsageReader>> = {};

      const accounts = yield* probeUpstreamUsage({
        driver,
        credentials: [{ providerId: "opencode", authType: "api", secret: "opencode-secret" }],
        readers,
      });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.id).toBe("opencode");
      expect(accounts[0]?.usageLimits.unavailable).toEqual({ reason: "unsupported" });
    }),
  );

  it.effect(
    "isolates a throwing or failing reader as probeFailed without affecting other accounts",
    () =>
      Effect.gen(function* () {
        const credentials: ReadonlyArray<StoredUpstreamCredential> = [
          { providerId: "pi", authType: "api_key", secret: "pi-secret" },
          { providerId: "opencode", authType: "api", secret: "opencode-secret" },
          { providerId: "anthropic", authType: "api_key", secret: "anthropic-secret" },
        ];
        const readers: Readonly<Record<string, UpstreamUsageReader>> = {
          pi: () =>
            Effect.sync(() => {
              throw new Error("transport exploded");
            }),
          opencode: () => Effect.fail(new UsageLimitSourceError({ detail: "rate limited" })),
          anthropic: (context) =>
            Effect.succeed({
              id: context.credential.providerId,
              driver: context.driver,
              usageLimits: { checkedAt: context.checkedAt, windows: [] },
            }),
        };

        const accounts = yield* probeUpstreamUsage({ driver, credentials, readers });

        expect(accounts.map((account) => account.id)).toEqual(["pi", "opencode", "anthropic"]);
        expect(accounts[0]?.usageLimits.unavailable).toEqual({
          reason: "probeFailed",
          message: "pi could not read usage.",
        });
        expect(accounts[1]?.usageLimits.unavailable).toEqual({
          reason: "probeFailed",
          message: "opencode could not read usage.",
        });
        expect(accounts[2]?.usageLimits.unavailable).toBeUndefined();
        expect(accounts[2]?.usageLimits.windows).toEqual([]);
      }),
  );
});
