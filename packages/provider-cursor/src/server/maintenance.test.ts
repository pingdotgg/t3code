import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { cursorMaintenance } from "./maintenance.ts";

it.layer(NodeServices.layer)("Cursor maintenance", (it) => {
  it.effect("uses the resolved Cursor Agent binary as its updater", () =>
    Effect.gen(function* () {
      const capabilities = yield* cursorMaintenance.resolve({
        binaryPath: "cursor-agent",
        resolvedCommandPath: "/home/user/.local/bin/cursor-agent",
        realCommandPath: "/home/user/.local/share/cursor-agent/versions/2026.11.05/cursor-agent",
        env: {},
        platform: "linux",
      });
      expect(capabilities).toMatchObject({
        provider: ProviderDriverKind.make("cursor"),
        packageName: null,
        update: {
          executable: "/home/user/.local/bin/cursor-agent",
          args: ["update"],
          lockKey: "cursor-agent",
        },
      });
      expect(capabilities.lookupLatestVersion).toBeDefined();
      expect(capabilities.compareVersions?.("2026.11.05-a", "2026.11.06-b")).toBeLessThan(0);
    }),
  );

  it.effect("stays manual-only when no Cursor binary resolves", () =>
    Effect.gen(function* () {
      const capabilities = yield* cursorMaintenance.resolve(null);
      expect(capabilities).toMatchObject({
        provider: ProviderDriverKind.make("cursor"),
        packageName: null,
        update: null,
      });
    }),
  );
});
