import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderChatWarning, resolveThreadErrorChatWarning } from "./ChatWarningIndicator";

const providerStatus = (status: "error" | "warning"): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status,
  auth: { status: "authenticated" },
  checkedAt: "2026-07-23T12:00:00.000Z",
  message: status === "error" ? "Process exited with code 1." : "Limited functionality.",
  models: [],
  slashCommands: [],
  skills: [],
});

describe("chat warnings", () => {
  it("keeps the provider failure reason", () => {
    expect(
      resolveProviderChatWarning(EnvironmentId.make("local"), providerStatus("error")),
    ).toMatchObject({
      title: "Codex is unavailable",
      description: "Process exited with code 1.",
      severity: "error",
    });
  });

  it("preserves degraded provider severity", () => {
    expect(
      resolveProviderChatWarning(EnvironmentId.make("local"), providerStatus("warning")),
    ).toMatchObject({
      title: "Codex has limited availability",
      severity: "warning",
    });
  });

  it("turns thread errors into separate warnings", () => {
    expect(resolveThreadErrorChatWarning("local:thread-a", "Turn failed")).toMatchObject({
      title: "Thread failed",
      description: "Turn failed",
      severity: "error",
    });
  });
});
