import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CopilotSettings } from "@t3tools/contracts";

import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  resolveCopilotAcpBaseModelId,
} from "./CopilotProvider.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

describe("buildInitialCopilotProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCopilotProviderSnapshot(
        decodeCopilotSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCopilotProviderSnapshot(
        decodeCopilotSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking GitHub Copilot");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );
});

describe("resolveCopilotAcpBaseModelId", () => {
  it("normalizes model slugs correctly", () => {
    expect(resolveCopilotAcpBaseModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveCopilotAcpBaseModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resolveCopilotAcpBaseModelId("")).toBe("gpt-5.6-sol");
    expect(resolveCopilotAcpBaseModelId(undefined)).toBe("gpt-5.6-sol");
  });
});

it.layer(NodeServices.layer)("checkCopilotProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCopilotProviderStatus(
        decodeCopilotSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/copilot-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken copilot install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copilot-version-" });
          const copilotPath = path.join(dir, "copilot");
          yield* fs.writeFileString(
            copilotPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(copilotPath, 0o755);

          return yield* checkCopilotProviderStatus(
            decodeCopilotSettings({ enabled: true, binaryPath: copilotPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("GitHub Copilot CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );
});
