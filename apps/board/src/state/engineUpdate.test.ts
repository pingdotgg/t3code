import type { ServerLifecycleStreamReadyEvent, ServerSelfUpdateOutcome } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canUpdateEngine,
  offeredRelease,
  type PendingUpdate,
  resolveUpdateOutcome,
} from "./engineUpdate";

const ACCEPTING_AT = "2026-11-20T10:00:00.000Z";
const RESTARTED_AT = "2026-11-20T10:02:00.000Z";

const pending = (overrides: Partial<PendingUpdate> = {}): PendingUpdate => ({
  fromVersion: "0.1.9",
  targetVersion: "0.1.10",
  updateId: "update-1",
  acceptedAt: ACCEPTING_AT,
  startedAt: 0,
  ...overrides,
});

// SAFETY: only the fields the matcher reads are filled in; it touches no others.
const ready = (
  at: string,
  serverVersion: string,
  updateOutcome?: Partial<ServerSelfUpdateOutcome>,
): ServerLifecycleStreamReadyEvent =>
  ({
    version: 1,
    sequence: 1,
    type: "ready",
    payload: {
      at,
      environment: { serverVersion },
      ...(updateOutcome === undefined
        ? {}
        : {
            updateOutcome: {
              id: "update-1",
              fromVersion: "0.1.9",
              targetVersion: "0.1.10",
              status: "committed",
              ...updateOutcome,
            },
          }),
    },
  }) as ServerLifecycleStreamReadyEvent;

describe("resolveUpdateOutcome", () => {
  it("Given a ready event with the pending updateId committed on the target, when matched, then the update committed", () => {
    expect(resolveUpdateOutcome(pending(), ready(RESTARTED_AT, "0.1.10", {}))).toEqual({
      status: "committed",
      version: "0.1.10",
    });
  });

  it("Given a ready event with the pending updateId rolled back, when matched, then the update rolled back with the launcher's reason", () => {
    expect(
      resolveUpdateOutcome(
        pending(),
        ready(RESTARTED_AT, "0.1.9", { status: "rolled-back", reason: "Trial exited with 1" }),
      ),
    ).toEqual({ status: "rolled-back", version: "0.1.9", reason: "Trial exited with 1" });
  });

  it("Given a committed outcome while the engine runs another version, when matched, then the update failed", () => {
    expect(resolveUpdateOutcome(pending(), ready(RESTARTED_AT, "0.1.9", {}))).toEqual({
      status: "failed",
      version: "0.1.9",
      reason: "The engine runs 0.1.9, not 0.1.10.",
    });
  });

  it("Given a restart that reports no outcome for the updateId, when matched, then the update failed", () => {
    expect(resolveUpdateOutcome(pending(), ready(RESTARTED_AT, "0.1.9"))).toEqual({
      status: "failed",
      version: "0.1.9",
      reason: "The service restarted without reporting the update.",
    });
  });

  it("Given the replayed ready of the process that accepted the update, when matched, then it keeps waiting", () => {
    expect(resolveUpdateOutcome(pending(), ready(ACCEPTING_AT, "0.1.9"))).toBeNull();
  });

  it("Given a server that named no updateId, when its ready shows the target version, then the update committed", () => {
    expect(
      resolveUpdateOutcome(pending({ updateId: undefined }), ready(RESTARTED_AT, "0.1.10")),
    ).toEqual({ status: "committed", version: "0.1.10" });
  });

  it("Given a server that named no updateId, when its ready shows the old version, then it keeps waiting", () => {
    expect(
      resolveUpdateOutcome(pending({ updateId: undefined }), ready(RESTARTED_AT, "0.1.9")),
    ).toBeNull();
  });
});

describe("offeredRelease", () => {
  it("Given a newer release, when offered, then it names that release", () => {
    expect(offeredRelease("0.1.9", "0.1.10")).toBe("0.1.10");
  });

  it("Given the same or an older release, when offered, then nothing is offered", () => {
    expect(offeredRelease("0.1.10", "0.1.10")).toBeNull();
    expect(offeredRelease("0.1.11", "0.1.10")).toBeNull();
  });

  it("Given no release or no version, when offered, then nothing is offered", () => {
    expect(offeredRelease("0.1.9", null)).toBeNull();
    expect(offeredRelease(null, "0.1.10")).toBeNull();
  });
});

describe("canUpdateEngine", () => {
  it("Given the background service, when it can update itself, then the app updates it", () => {
    expect(canUpdateEngine("service", "boot-service")).toBe(true);
  });

  it("Given an engine reached through AGENT_BOARD_ENGINE_URL, when it can update itself, then the app shows the version only", () => {
    expect(canUpdateEngine("url", "boot-service")).toBe(false);
  });

  it("Given a desktop-managed or non-updating engine, when asked, then the app does not update it", () => {
    expect(canUpdateEngine("service", "desktop-managed")).toBe(false);
    expect(canUpdateEngine("service", undefined)).toBe(false);
  });
});
