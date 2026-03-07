import assert from "node:assert/strict";
import { Effect } from "effect";
import { afterEach, describe, it, vi } from "vitest";

import * as CliEnvironment from "../../cliEnvironment";
import {
  checkCodexProviderStatus,
  checkGeminiProviderStatus,
  parseAuthStatusFromOutput,
} from "./ProviderHealth";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("ProviderHealth", () => {
  it("returns ready when codex CLI is available", async () => {
    vi.spyOn(CliEnvironment, "isCodexCliAvailable").mockReturnValue(true);

    const status = await Effect.runPromise(checkCodexProviderStatus);
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "ready");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "unknown");
  });

  it("returns unavailable when codex CLI is missing", async () => {
    vi.spyOn(CliEnvironment, "isCodexCliAvailable").mockReturnValue(false);

    const status = await Effect.runPromise(checkCodexProviderStatus);
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "error");
    assert.strictEqual(status.available, false);
    assert.strictEqual(status.authStatus, "unknown");
    assert.strictEqual(status.message, "Codex CLI (`codex`) is not installed or not on PATH.");
  });

  it("returns ready when gemini CLI is available without forcing auth", async () => {
    vi.spyOn(CliEnvironment, "isGeminiCliAvailable").mockReturnValue(true);
    vi.stubEnv("GEMINI_API_KEY", "");

    const status = await Effect.runPromise(checkGeminiProviderStatus);
    assert.strictEqual(status.provider, "gemini");
    assert.strictEqual(status.status, "ready");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "unknown");
  });

  it("marks gemini as authenticated when GEMINI_API_KEY is present", async () => {
    vi.spyOn(CliEnvironment, "isGeminiCliAvailable").mockReturnValue(true);
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    const status = await Effect.runPromise(checkGeminiProviderStatus);
    assert.strictEqual(status.provider, "gemini");
    assert.strictEqual(status.status, "ready");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "authenticated");
  });
});

describe("parseAuthStatusFromOutput", () => {
  it("treats exit code 0 with no auth markers as ready", () => {
    const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
    assert.strictEqual(parsed.status, "ready");
    assert.strictEqual(parsed.authStatus, "authenticated");
  });

  it("detects authenticated=false in JSON", () => {
    const parsed = parseAuthStatusFromOutput({
      stdout: '[{"authenticated":false}]\n',
      stderr: "",
      code: 0,
    });
    assert.strictEqual(parsed.status, "error");
    assert.strictEqual(parsed.authStatus, "unauthenticated");
  });

  it("returns warning for JSON without auth markers", () => {
    const parsed = parseAuthStatusFromOutput({
      stdout: '[{"ok":true}]\n',
      stderr: "",
      code: 0,
    });
    assert.strictEqual(parsed.status, "warning");
    assert.strictEqual(parsed.authStatus, "unknown");
  });
});
