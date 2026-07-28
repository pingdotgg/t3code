import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MAX_HERMES_SESSION_IMPORT_AGE_DAYS,
  HermesSessionDiscoveryResult,
  HermesHistoryResetInput,
  HermesHistoryResetResult,
  HermesSessionImportInput,
  HermesSessionImportResult,
} from "./hermesSessions.ts";

const decodeHermesSessionDiscoveryResult = Schema.decodeUnknownSync(HermesSessionDiscoveryResult);
const decodeHermesHistoryResetInput = Schema.decodeUnknownSync(HermesHistoryResetInput);
const decodeHermesHistoryResetResult = Schema.decodeUnknownSync(HermesHistoryResetResult);
const decodeHermesSessionImportInput = Schema.decodeUnknownSync(HermesSessionImportInput);
const decodeHermesSessionImportResult = Schema.decodeUnknownSync(HermesSessionImportResult);

describe("Hermes session import contracts", () => {
  it("decodes capability-gated discovery without inventing child lineage", () => {
    const result = decodeHermesSessionDiscoveryResult({
      providerInstanceId: "hermes-work",
      profileKey: "default",
      sessions: [
        {
          storedSessionId: "20260725_120000_a1b2c3",
          title: "Existing conversation",
          preview: "hello",
          startedAt: 1_753_444_800,
          settlement: "unsettled",
          messageCount: 2,
          source: "tui",
          importedThreadId: null,
        },
      ],
      capabilities: {
        discovery: true,
        lazyHistory: true,
        transportSources: ["discord", "telegram"],
        activityTimestamp: {
          field: "started_at",
          limitation: "last_active is unavailable",
        },
        childSessionLineage: { available: false, reason: "not exposed" },
        copyChildSession: { available: false, reason: "latest head only" },
      },
      mainThreadId: null,
    });

    expect(result.sessions[0]?.storedSessionId).toBe("20260725_120000_a1b2c3");
    expect(result.capabilities.childSessionLineage.available).toBe(false);
  });

  it("supports recent, selected, and all import selections", () => {
    expect(
      decodeHermesSessionImportInput({
        providerInstanceId: "hermes-work",
        backingProjectId: "internal-work-backing",
        selection: { type: "recent", limit: 20 },
        activeWithinDays: 1,
      }).selection.type,
    ).toBe("recent");
    expect(
      decodeHermesSessionImportInput({
        providerInstanceId: "hermes-work",
        backingProjectId: "internal-work-backing",
        selection: { type: "selected", sessionIds: ["one", "two"] },
        activeWithinDays: 7,
      }).selection.type,
    ).toBe("selected");
    expect(
      decodeHermesSessionImportInput({
        providerInstanceId: "hermes-work",
        backingProjectId: "internal-work-backing",
        selection: { type: "all" },
        activeWithinDays: MAX_HERMES_SESSION_IMPORT_AGE_DAYS,
      }).selection.type,
    ).toBe("all");
  });

  it("requires a whole-day import age inside the server-enforced range", () => {
    const input = {
      providerInstanceId: "hermes-work",
      backingProjectId: "internal-work-backing",
      selection: { type: "all" },
    };

    expect(() => decodeHermesSessionImportInput({ ...input, activeWithinDays: 0 })).toThrow();
    expect(() => decodeHermesSessionImportInput({ ...input, activeWithinDays: 1.5 })).toThrow();
    expect(() =>
      decodeHermesSessionImportInput({
        ...input,
        activeWithinDays: MAX_HERMES_SESSION_IMPORT_AGE_DAYS + 1,
      }),
    ).toThrow();
  });

  it("defaults the server-decoded import age to one day", () => {
    const decoded = decodeHermesSessionImportInput({
      providerInstanceId: "hermes-work",
      backingProjectId: "internal-work-backing",
      selection: { type: "all" },
    });

    expect(decoded.activeWithinDays).toBe(1);
  });

  it("decodes idempotent import outcomes and the durable Main identity", () => {
    const result = decodeHermesSessionImportResult({
      providerInstanceId: "hermes-work",
      profileKey: "default",
      imported: [
        {
          storedSessionId: "session-1",
          threadId: "thread-1",
          settlement: "settled",
          status: "already_imported",
        },
      ],
      mainThreadId: "main-thread",
      capabilities: {
        discovery: true,
        lazyHistory: true,
        transportSources: ["discord", "telegram"],
        activityTimestamp: {
          field: "started_at",
          limitation: "last_active is unavailable",
        },
        childSessionLineage: { available: false, reason: "not exposed" },
        copyChildSession: { available: false, reason: "latest head only" },
      },
    });
    expect(result.imported[0]?.status).toBe("already_imported");
    expect(result.mainThreadId).toBe("main-thread");
  });

  it("decodes an explicit T3 Work history reset", () => {
    expect(
      decodeHermesHistoryResetInput({
        providerInstanceId: "hermes-work",
        backingProjectId: "project:t3-work",
        operationId: "reset-1",
      }),
    ).toEqual({
      providerInstanceId: "hermes-work",
      backingProjectId: "project:t3-work",
      operationId: "reset-1",
    });
    expect(
      decodeHermesHistoryResetResult({
        deletedThreadCount: 4,
        clearedImportCount: 3,
      }),
    ).toEqual({
      deletedThreadCount: 4,
      clearedImportCount: 3,
    });
  });
});
