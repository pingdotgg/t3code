import { describe, expect, it } from "vite-plus/test";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  CURSOR_ABOUT_TIMEOUT_MS,
  CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS,
  GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS,
  PROVIDER_AUTH_PROBE_TIMEOUT_MS,
  PROVIDER_VERSION_PROBE_TIMEOUT_MS,
  resolveProviderProbeCwd,
} from "./providerProbeTimeouts.ts";

describe("providerProbeTimeouts", () => {
  it("uses higher probe timeouts on Windows", () => {
    if (process.platform === "win32") {
      expect(CURSOR_ABOUT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
      expect(CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
      expect(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
      expect(PROVIDER_AUTH_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
      expect(PROVIDER_VERSION_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    } else {
      expect(CURSOR_ABOUT_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
      expect(PROVIDER_AUTH_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    }
  });

  it("resolveProviderProbeCwd prefers explicit cwd when it exists", () => {
    const preferred = NodeOs.tmpdir();
    expect(resolveProviderProbeCwd(preferred)).toBe(preferred);
  });

  it("resolveProviderProbeCwd ignores non-directories and falls back", () => {
    const missing = NodePath.join(NodeOs.tmpdir(), `t3-missing-cwd-${Date.now()}`);
    const resolved = resolveProviderProbeCwd(missing, {
      T3_PROVIDER_CWD: NodeOs.tmpdir(),
    });
    expect(resolved).toBe(NodeOs.tmpdir());
  });

  it("resolveProviderProbeCwd always returns an existing directory", () => {
    const resolved = resolveProviderProbeCwd(null, {});
    expect(NodeFs.statSync(resolved).isDirectory()).toBe(true);
  });
});
