import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentSessionAttachInput,
  AgentSessionListInput,
  AgentSessionListResult,
  AgentSessionPreviewInput,
  AgentSessionScanResult,
} from "./agentSessions.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);
const decodeAttachInput = Schema.decodeUnknownSync(AgentSessionAttachInput);
const decodePreviewInput = Schema.decodeUnknownSync(AgentSessionPreviewInput);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

it("requires project scope and a native session identity rather than a client-selected path", () => {
  const input = {
    projectId: "project",
    expectedWorkspaceRoot: "/project",
    providerInstanceId: "claudeAgent",
    providerSessionId: "123e4567-e89b-42d3-a456-426614174000",
  };
  expect(decodeAttachInput(input)).toEqual(input);
  expect(() => decodeAttachInput({ ...input, expectedWorkspaceRoot: undefined })).toThrow();
  expect(() => decodeAttachInput({ ...input, providerSessionId: "../../other.jsonl" })).toThrow();
  expect(() => decodePreviewInput({ ...input, before: -1 })).toThrow();
});

it("carries opaque session listing cursors instead of numeric offsets", () => {
  const decodeInput = Schema.decodeUnknownSync(AgentSessionListInput);
  const decodeResult = Schema.decodeUnknownSync(AgentSessionListResult);
  const input = { projectId: "project", expectedWorkspaceRoot: "/project" };
  const cursor = "server-held-page-token";
  expect(decodeInput(input)).toEqual(input);
  expect(decodeInput({ ...input, cursor }).cursor).toBe(cursor);
  expect(() => decodeInput({ ...input, cursor: 40 })).toThrow();
  expect(decodeResult({ sessions: [], nextCursor: cursor, truncated: false }).nextCursor).toBe(
    cursor,
  );
  expect(decodeResult({ sessions: [], nextCursor: null, truncated: false }).nextCursor).toBeNull();
  expect(() => decodeResult({ sessions: [], nextCursor: 40, truncated: false })).toThrow();
});

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
