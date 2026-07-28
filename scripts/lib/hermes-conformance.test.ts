// @effect-diagnostics nodeBuiltinImport:off - Tests create isolated Git fixtures directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  HERMES_PINNED_REVISION,
  canRunModeProbe,
  canRunProbe,
  exitCodeFor,
  sanitizeCapture,
  verifyPinnedSource,
} from "./hermes-conformance.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("sanitizeCapture", () => {
  it("retains only allowlisted protocol structure and pseudonymous correlation", () => {
    const sanitized = sanitizeCapture({
      session_id: "session-123",
      apiKey: "top-secret",
      token: 424242,
      cwd: "/Users/alice/private/project",
      content: "private prompt",
      data: "data:image/png;base64,AAAA",
      method: "session.history",
      revision: HERMES_PINNED_REVISION,
    });

    expect(sanitized).toMatchObject({
      session_id: expect.stringMatching(/^<session_id:/),
      method: "session.history",
      revision: HERMES_PINNED_REVISION,
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("424242");
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("AAAA");
  });

  it("redacts unknown numeric data while retaining allowlisted protocol counts", () => {
    const serialized = JSON.stringify(
      sanitizeCapture({
        count: 3,
        started_at: 1_784_945_964.894,
        arbitraryMetric: 8675309,
      }),
    );
    expect(serialized).toContain('"count":3');
    expect(serialized).not.toContain("1784945964.894");
    expect(serialized).not.toContain("8675309");
  });

  it("redacts adversarial titles, URLs, tool arguments, errors, filenames, and unknown fields", () => {
    const sanitized = JSON.stringify(
      sanitizeCapture({
        title: "customer roadmap",
        url: "https://example.invalid/path?token=credential",
        filename: "secret-client-name.pdf",
        error: { message: "Bearer abc123", body: "private response" },
        arguments: {
          query: "confidential search",
          arbitrarySecretField: "do-not-publish",
        },
        result: {
          nested: { value: "private result" },
        },
      }),
    );

    for (const secret of [
      "customer roadmap",
      "example.invalid",
      "credential",
      "secret-client-name.pdf",
      "Bearer abc123",
      "private response",
      "confidential search",
      "arbitrarySecretField",
      "do-not-publish",
      "private result",
    ]) {
      expect(sanitized).not.toContain(secret);
    }
  });
});

describe("canRunProbe", () => {
  it("requires separate explicit opt-ins", () => {
    expect(canRunProbe("read", {}).allowed).toBe(true);
    expect(canRunProbe("disposable-write", {}).allowed).toBe(false);
    expect(
      canRunProbe("live", {
        HERMES_CONFORMANCE_ALLOW_MUTATIONS: "1",
      }).allowed,
    ).toBe(false);
    expect(
      canRunProbe("destructive", {
        HERMES_CONFORMANCE_ALLOW_MUTATIONS: "1",
        HERMES_CONFORMANCE_ALLOW_DESTRUCTIVE: "1",
      }).allowed,
    ).toBe(true);
  });

  it("keeps attach mode read-only even when every mutation gate is enabled", () => {
    const enabled = {
      HERMES_CONFORMANCE_ALLOW_MUTATIONS: "1",
      HERMES_CONFORMANCE_ALLOW_LIVE: "1",
      HERMES_CONFORMANCE_ALLOW_DESTRUCTIVE: "1",
    };

    expect(canRunModeProbe("attach", "read", enabled).allowed).toBe(true);
    expect(canRunModeProbe("attach", "disposable-write", enabled).allowed).toBe(false);
    expect(canRunModeProbe("attach", "live", enabled).allowed).toBe(false);
    expect(canRunModeProbe("attach", "destructive", enabled).allowed).toBe(false);
    expect(canRunModeProbe("launch", "destructive", enabled).allowed).toBe(true);
  });
});

describe("verifyPinnedSource", () => {
  it("accepts only a clean checkout at the exact pin", () => {
    const directory = makeTemporaryDirectory();
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: directory });
    NodeChildProcess.execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: directory,
    });
    NodeChildProcess.execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
    NodeFS.mkdirSync(NodePath.join(directory, "tui_gateway"));
    NodeFS.writeFileSync(NodePath.join(directory, "tui_gateway", "server.py"), "");
    NodeFS.writeFileSync(NodePath.join(directory, "tui_gateway", "ws.py"), "");
    NodeChildProcess.execFileSync("git", ["add", "."], { cwd: directory });
    NodeChildProcess.execFileSync("git", ["commit", "-qm", "fixture"], { cwd: directory });

    const result = verifyPinnedSource(directory);

    expect(result.verified).toBe(false);
    expect(result.actual).toMatch(/^[0-9a-f]{40}$/);
    expect(result.reason).toContain("does not match");
  });
});

describe("exitCodeFor", () => {
  it("fails closed for critical gaps and failures", () => {
    expect(
      exitCodeFor([
        {
          id: "revision",
          area: "security",
          safety: "read",
          status: "blocked",
          summary: "unverified",
          critical: true,
        },
      ]),
    ).toBe(1);
    expect(
      exitCodeFor([
        {
          id: "optional",
          area: "attachments",
          safety: "disposable-write",
          status: "blocked",
          summary: "not enabled",
        },
      ]),
    ).toBe(0);
  });
});

function makeTemporaryDirectory(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
