import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { probeAcpRegistryConfiguration } from "./probe.ts";

/**
 * Live proof of the `account/usage_stats` probe pull — spawns the local bridge and
 * calls the real backend. Skipped unless explicitly requested:
 *   ZCODE_E2E=1 ZCODE_ACP_DIST=C:/…/zcode-acp/dist \
 *     pnpm exec vp test run packages/provider-acp-registry/src/server/usageStats.e2e.test.ts
 */

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const adapterDist = process.env.ZCODE_ACP_DIST;
const e2eCwd = process.env.ZCODE_E2E_CWD ?? process.cwd();
const e2eEnvironment = { ...process.env };
const enabled = process.env.ZCODE_E2E === "1" && adapterDist !== undefined;

const liveCatalog = AcpRegistrySupport.layerFromHost.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestProviderHost.layer(),
      NodeServices.layer,
      NodeCrypto.layer,
      FetchHttpClient.layer,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer)),
);

describe.skipIf(!enabled)("usageStats probe pull (live zcode-acp)", () => {
  it.effect("pulls the ZCode Global Build grant into usageLimits", () =>
    Effect.gen(function* () {
      const dist = adapterDist;
      if (dist === undefined) return yield* Effect.void;
      const result = yield* probeAcpRegistryConfiguration({
        instanceId: ProviderInstanceId.make("acpRegistry_usage_e2e"),
        settings: decodeSettings({
          source: "local",
          commandPath: process.execPath,
          commandArgs: [`${dist.replaceAll("\\", "/")}/cli.js`, "server"],
          enabled: true,
        }),
        cwd: e2eCwd,
        environment: e2eEnvironment,
      });

      const limits = result.usageLimits;
      expect(limits).toBeDefined();
      expect(limits?.windows.length).toBeGreaterThan(0);
      const grant = limits?.windows.find((window) => window.id.startsWith("zcode:"));
      expect(grant).toBeDefined();
      expect(grant?.label).toContain("ZCODE GLOBAL BUILD");
      expect(grant?.usedPercent).toBeGreaterThan(0);
      expect(grant?.usedPercent).toBeLessThanOrEqual(100);
      expect(grant?.resetsAt).toBeDefined();
      expect(grant?.modelIds?.length ?? 0).toBeGreaterThan(0);
    }).pipe(Effect.provide(liveCatalog)),
  );
});
