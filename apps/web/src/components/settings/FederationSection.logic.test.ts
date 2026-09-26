import { EnvironmentId, FederationRemoteRun } from "@t3tools/contracts";
import {
  encodeFederationPeerCode,
  encodeTailcatConnectionCode,
} from "@t3tools/shared/t3ConnectionCode";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  describeFederationPeerCode,
  remoteRunLastEventSummary,
  remoteRunStatusBadgeVariant,
  remoteRunStatusLabel,
  toggleFederationScope,
} from "./FederationSection.logic";

const ADDRESS = `tc${"b".repeat(40)}`;
const NOW_MS = Date.parse("2026-09-03T12:00:00.000Z");

const decodeRemoteRun = Schema.decodeUnknownSync(FederationRemoteRun);

function remoteRun(overrides: {
  readonly requestedAt: string;
  readonly events?: ReadonlyArray<{
    readonly sequence: number;
    readonly at: string;
    readonly type: string;
    readonly summary: string;
  }>;
  readonly assistantPreview?: string | null;
}): FederationRemoteRun {
  return decodeRemoteRun({
    peerId: "env-peer",
    peerLabel: "Build box",
    run: {
      environmentId: "env-peer",
      projectId: "project-1",
      threadId: "thread-1",
      turnId: null,
      title: "Fix flaky test",
      status: "running",
      runtimeMode: "full-access",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      requestedAt: overrides.requestedAt,
      startedAt: null,
      completedAt: null,
      assistantPreview: overrides.assistantPreview ?? null,
      turnCount: 1,
    },
    events: overrides.events ?? [],
    lastSyncedAt: null,
    syncError: null,
  });
}

describe("remote run presentation", () => {
  it("labels statuses", () => {
    expect(remoteRunStatusLabel("queued")).toBe("Queued");
    expect(remoteRunStatusLabel("error")).toBe("Failed");
    expect(remoteRunStatusBadgeVariant("running")).toBe("warning");
    expect(remoteRunStatusBadgeVariant("completed")).toBe("success");
  });

  it("prefers the newest event summary, then the assistant preview", () => {
    const at = "2026-09-03T12:00:00.000Z";
    expect(
      remoteRunLastEventSummary(
        remoteRun({
          requestedAt: at,
          events: [
            { sequence: 1, at, type: "turn.started", summary: "Turn started" },
            { sequence: 2, at, type: "turn.completed", summary: "Turn completed" },
          ],
          assistantPreview: "Working on it",
        }),
      ),
    ).toBe("Turn completed");
    expect(
      remoteRunLastEventSummary(remoteRun({ requestedAt: at, assistantPreview: "  Working  " })),
    ).toBe("Working");
    expect(remoteRunLastEventSummary(remoteRun({ requestedAt: at }))).toBeNull();
  });
});

describe("toggleFederationScope", () => {
  it("adds once and removes cleanly", () => {
    expect(toggleFederationScope(["runs.read"], "runs.start", true)).toEqual([
      "runs.read",
      "runs.start",
    ]);
    expect(toggleFederationScope(["runs.read"], "runs.read", true)).toEqual(["runs.read"]);
    expect(toggleFederationScope(["runs.read", "runs.start"], "runs.read", false)).toEqual([
      "runs.start",
    ]);
  });
});

describe("describeFederationPeerCode", () => {
  it("previews a valid peer code and detects expiry", () => {
    const code = encodeFederationPeerCode({
      v: 1,
      kind: "peer",
      protocolVersion: 1,
      environmentId: EnvironmentId.make("env-2"),
      publicKey: "pem",
      label: "Build box",
      transport: { tailcat: { address: ADDRESS, port: 3773 } },
      token: "one-time",
      scopes: ["environment.read", "runs.start"],
      expiresAt: "2026-09-03T12:05:00.000Z",
    });
    expect(describeFederationPeerCode(code, NOW_MS)).toEqual({
      kind: "valid",
      payload: expect.objectContaining({
        label: "Build box",
        scopes: ["environment.read", "runs.start"],
      }),
      expired: false,
    });
    expect(describeFederationPeerCode(code, Date.parse("2026-09-03T12:06:00.000Z"))).toMatchObject({
      kind: "valid",
      expired: true,
    });
  });

  it("redirects Tailcat codes and rejects everything else", () => {
    const tailcatCode = encodeTailcatConnectionCode({
      v: 1,
      transport: "tailcat",
      address: ADDRESS,
      port: 3773,
      environmentId: EnvironmentId.make("env-studio"),
      name: "Studio",
      serverVersion: "0.9.0",
      pairingToken: "one-time",
      expiresAt: "2026-09-03T12:05:00.000Z",
    });
    expect(describeFederationPeerCode(tailcatCode, NOW_MS)).toMatchObject({ kind: "tailcat-code" });
    expect(describeFederationPeerCode("   ", NOW_MS)).toEqual({ kind: "empty" });
    expect(describeFederationPeerCode("nope", NOW_MS)).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("t3c://peer/"),
    });
  });
});
