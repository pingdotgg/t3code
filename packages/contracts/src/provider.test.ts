import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSessionStartInput } from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      provider: "codex",
      cwd: "/tmp/workspace",
      model: "gpt-5.3-codex",
      providerOptions: {
        codex: {
          binaryPath: "/usr/local/bin/codex",
          homePath: "/tmp/.codex",
        },
      },
    });
    expect(parsed.approvalPolicy).toBeUndefined();
    expect(parsed.sandboxMode).toBeUndefined();
    expect(parsed.providerOptions?.codex?.binaryPath).toBe("/usr/local/bin/codex");
    expect(parsed.providerOptions?.codex?.homePath).toBe("/tmp/.codex");
  });

  it("accepts claude runtime knobs", () => {
    const parsed = decodeProviderSessionStartInput({
      provider: "claudeCode",
      cwd: "/tmp/workspace",
      model: "claude-sonnet-4-6",
      providerOptions: {
        claudeCode: {
          binaryPath: "/usr/local/bin/claude",
          permissionMode: "plan",
          maxThinkingTokens: 12_000,
        },
      },
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
    });
    expect(parsed.provider).toBe("claudeCode");
    expect(parsed.providerOptions?.claudeCode?.binaryPath).toBe("/usr/local/bin/claude");
    expect(parsed.providerOptions?.claudeCode?.permissionMode).toBe("plan");
    expect(parsed.providerOptions?.claudeCode?.maxThinkingTokens).toBe(12_000);
    expect(parsed.approvalPolicy).toBe("never");
    expect(parsed.sandboxMode).toBe("danger-full-access");
  });

  it("accepts cursor provider payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      provider: "cursor",
      cwd: "/tmp/workspace",
      model: "composer-1.5",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });
    expect(parsed.provider).toBe("cursor");
    expect(parsed.model).toBe("composer-1.5");
    expect(parsed.approvalPolicy).toBe("on-request");
    expect(parsed.sandboxMode).toBe("workspace-write");
  });
});
