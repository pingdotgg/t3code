import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "@t3tools/contracts";

import {
  buildInitialAcpRegistryProviderSnapshot,
  checkAcpRegistryProviderStatus,
} from "./AcpRegistryProvider.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

describe("buildInitialAcpRegistryProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAcpRegistryProviderSnapshot(
        decodeSettings({ enabled: false, catalogId: "gemini", command: "gemini" }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.displayName).toBe("Gemini");
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("asks for a launch command when none is configured", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAcpRegistryProviderSnapshot(
        decodeSettings({ enabled: true, catalogId: "gemini" }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toMatch(/launch command/i);
      expect(snapshot.message).toContain("gemini");
    }),
  );

  it.effect("returns a pending snapshot while probing a configured command", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAcpRegistryProviderSnapshot(
        decodeSettings({ enabled: true, catalogId: "gemini", command: "gemini" }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("Checking ACP");
    }),
  );
});

it.layer(NodeServices.layer)("checkAcpRegistryProviderStatus", (it) => {
  it.effect("reports the command as missing when it does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderStatus(
        decodeSettings({
          enabled: true,
          catalogId: "gemini",
          command: "/definitely/not/installed/gemini-acp",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH/i);
    }),
  );
});
