import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";

import { checkCodexProviderStatus, parseAuthStatusFromOutput } from "./ProviderHealth";

// ── Test helpers ────────────────────────────────────────────────────

function mockRunner(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number | null;
    signal?: NodeJS.Signals | null;
    timedOut?: boolean;
  },
) {
  return (args: ReadonlyArray<string>) => Promise.resolve(handler(args));
}

function failingRunner(description: string) {
  return () => Promise.reject(new Error(description));
}

// ── Tests ───────────────────────────────────────────────────────────

it.effect("returns ready when codex is installed and authenticated", () =>
  Effect.gen(function* () {
    const status = yield* checkCodexProviderStatus(
      mockRunner((args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
        throw new Error(`Unexpected args: ${joined}`);
      }),
    );
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "ready");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "authenticated");
  }),
);

it.effect("returns unavailable when codex is missing", () =>
  Effect.gen(function* () {
    const status = yield* checkCodexProviderStatus(failingRunner("spawn codex ENOENT"));
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "error");
    assert.strictEqual(status.available, false);
    assert.strictEqual(status.authStatus, "unknown");
    assert.strictEqual(status.message, "Codex CLI (`codex`) is not installed or not on PATH.");
  }),
);

it.effect("returns unauthenticated when auth probe reports login required", () =>
  Effect.gen(function* () {
    const status = yield* checkCodexProviderStatus(
      mockRunner((args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") {
          return { stdout: "", stderr: "Not logged in. Run codex login.", code: 1 };
        }
        throw new Error(`Unexpected args: ${joined}`);
      }),
    );
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "error");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "unauthenticated");
    assert.strictEqual(
      status.message,
      "Codex CLI is not authenticated. Run `codex login` and try again.",
    );
  }),
);

it.effect(
    "returns unauthenticated when login status output includes 'not logged in'",
  () =>
    Effect.gen(function* () {
      const status = yield* checkCodexProviderStatus(
        mockRunner((args) => {
          const joined = args.join(" ");
          if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
          if (joined === "login status")
            return { stdout: "Not logged in\n", stderr: "", code: 1 };
          throw new Error(`Unexpected args: ${joined}`);
        }),
      );
      assert.strictEqual(status.provider, "codex");
      assert.strictEqual(status.status, "error");
      assert.strictEqual(status.available, true);
      assert.strictEqual(status.authStatus, "unauthenticated");
      assert.strictEqual(
        status.message,
        "Codex CLI is not authenticated. Run `codex login` and try again.",
      );
    }),
);

it.effect("returns warning when login status command is unsupported", () =>
  Effect.gen(function* () {
    const status = yield* checkCodexProviderStatus(
      mockRunner((args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") {
          return { stdout: "", stderr: "error: unknown command 'login'", code: 2 };
        }
        throw new Error(`Unexpected args: ${joined}`);
      }),
    );
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "warning");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "unknown");
    assert.strictEqual(
      status.message,
      "Codex CLI authentication status command is unavailable in this Codex version.",
    );
  }),
);

it.effect("returns unavailable when codex version probe times out", () =>
  Effect.gen(function* () {
    const status = yield* checkCodexProviderStatus(
      mockRunner((args) => {
        const joined = args.join(" ");
        if (joined === "--version") {
          return { stdout: "", stderr: "", code: null, timedOut: true };
        }
        throw new Error(`Unexpected args: ${joined}`);
      }),
    );
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "error");
    assert.strictEqual(status.available, false);
    assert.strictEqual(status.authStatus, "unknown");
    assert.strictEqual(status.message, "Codex CLI is installed but failed to run. Timed out while running command.");
  }),
);

it("parseAuthStatusFromOutput: timed out auth check is warning", () => {
  const parsed = parseAuthStatusFromOutput({ stdout: "", stderr: "", code: null, timedOut: true });
  assert.strictEqual(parsed.status, "warning");
  assert.strictEqual(parsed.authStatus, "unknown");
  assert.strictEqual(parsed.message, "Timed out while checking Codex authentication status.");
});

it.effect("reports signal-based auth probe failures without 'code null'", () =>
  Effect.gen(function* () {
    const status = yield* checkCodexProviderStatus(
      mockRunner((args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") {
          return { stdout: "", stderr: "", code: null, signal: "SIGTERM" };
        }
        throw new Error(`Unexpected args: ${joined}`);
      }),
    );
    assert.strictEqual(status.status, "warning");
    assert.strictEqual(status.authStatus, "unknown");
    assert.strictEqual(
      status.message,
      "Could not verify Codex authentication status. Command exited from signal SIGTERM.",
    );
  }),
);

// ── Pure function tests ─────────────────────────────────────────────

it("parseAuthStatusFromOutput: exit code 0 with no auth markers is ready", () => {
  const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
  assert.strictEqual(parsed.status, "ready");
  assert.strictEqual(parsed.authStatus, "authenticated");
});

it("parseAuthStatusFromOutput: JSON with authenticated=false is unauthenticated", () => {
  const parsed = parseAuthStatusFromOutput({
    stdout: '[{"authenticated":false}]\n',
    stderr: "",
    code: 0,
  });
  assert.strictEqual(parsed.status, "error");
  assert.strictEqual(parsed.authStatus, "unauthenticated");
});

it("parseAuthStatusFromOutput: JSON without auth marker is warning", () => {
  const parsed = parseAuthStatusFromOutput({
    stdout: '[{"ok":true}]\n',
    stderr: "",
    code: 0,
  });
  assert.strictEqual(parsed.status, "warning");
  assert.strictEqual(parsed.authStatus, "unknown");
});
