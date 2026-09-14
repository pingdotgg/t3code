import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentSessionImportInput,
  AgentSessionImportResult,
  AgentSessionPreviewResult,
  AgentSessionScanResult,
} from "./agentSessions.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);
const decodeImportInput = Schema.decodeUnknownSync(AgentSessionImportInput);
const decodeImportResult = Schema.decodeUnknownSync(AgentSessionImportResult);
const decodePreviewResult = Schema.decodeUnknownSync(AgentSessionPreviewResult);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});

describe("reviewed agent history", () => {
  it("distinguishes an empty selection from a legacy bulk request", () => {
    expect(decodeImportInput({ projectId: "project" }).selection).toBeUndefined();
    expect(decodeImportInput({ projectId: "project", selection: [] }).selection).toEqual([]);
    expect(() =>
      decodeImportInput({
        projectId: "project",
        selection: [{ providerInstanceId: "codex", providerSessionId: "session" }],
      }),
    ).toThrow();
  });

  it("bounds an explicit selection and requires transcript revisions", () => {
    const session = {
      providerInstanceId: "codex",
      providerSessionId: "session",
      revision: "revision",
    };
    expect(() =>
      decodeImportInput({
        projectId: "project",
        selection: Array.from({ length: 101 }, () => session),
      }),
    ).toThrow();
    expect(() =>
      decodeImportInput({ projectId: "project", selection: [{ ...session, revision: "" }] }),
    ).toThrow();
  });

  it("reads legacy counts without inventing precise outcomes", () => {
    const result = decodeImportResult({
      importedCount: 2,
      skippedCount: 1,
    });
    expect(result.failedCount).toBeUndefined();
    expect(result.alreadyImportedCount).toBeUndefined();
  });

  it("keeps preview selections free of server transcript paths and history bodies", () => {
    const result = decodePreviewResult({
      sessions: [
        {
          providerInstanceId: "codex",
          providerSessionId: "session",
          revision: "revision",
          title: "Fix startup",
          createdAt: "2026-09-14T20:00:00.000Z",
          messageCount: 2,
          filePath: "/private/transcript.jsonl",
          messages: ["private history"],
        },
      ],
      alreadyImportedCount: 0,
      excludedCount: 0,
      failedCount: 0,
      deferredCount: 0,
    });
    expect(result.sessions[0]).not.toHaveProperty("filePath");
    expect(result.sessions[0]).not.toHaveProperty("messages");
  });
});
