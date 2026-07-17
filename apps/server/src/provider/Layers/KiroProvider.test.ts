import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { KiroSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { buildInitialKiroProviderSnapshot, checkKiroProviderStatus } from "./KiroProvider.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

describe("buildInitialKiroProviderSnapshot", () => {
  it.effect("returns a pending enabled snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(decodeKiroSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("Checking Kiro");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkKiroProviderStatus", (it) => {
  it.effect("reports a missing Kiro CLI binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({
          binaryPath: "/definitely/not/installed/kiro-cli",
        }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("not installed");
    }),
  );
});
