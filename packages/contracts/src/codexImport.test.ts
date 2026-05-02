import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  CodexImportImportSessionsInput,
  CodexImportListSessionsInput,
  CodexImportPeekSessionInput,
  ProjectId,
  WS_METHODS,
} from "./index.ts";

const decodeListSessionsInput = Schema.decodeUnknownEffect(CodexImportListSessionsInput);
const decodeImportSessionsInput = Schema.decodeUnknownEffect(CodexImportImportSessionsInput);
const decodePeekSessionInput = Schema.decodeUnknownEffect(CodexImportPeekSessionInput);

it.effect("decodes Codex import list defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeListSessionsInput({});
    assert.strictEqual(parsed.kind, "direct");
  }),
);

it.effect("trims Codex import peek session input", () =>
  Effect.gen(function* () {
    const parsed = yield* decodePeekSessionInput({
      homePath: " ~/.codex-alt ",
      sessionId: " session-1 ",
      messageCount: 10,
    });
    assert.strictEqual(parsed.homePath, "~/.codex-alt");
    assert.strictEqual(parsed.sessionId, "session-1");
  }),
);

it.effect("decodes Codex import target project input", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeImportSessionsInput({
      targetProjectId: " project-1 ",
      sessionIds: [" session-1 "],
    });
    assert.strictEqual(parsed.targetProjectId, ProjectId.make("project-1"));
    assert.deepStrictEqual(parsed.sessionIds, ["session-1"]);
  }),
);

it.effect("exports codex import rpc method ids", () =>
  Effect.sync(() => {
    assert.strictEqual(WS_METHODS.codexImportListSessions, "codexImport.listSessions");
    assert.strictEqual(WS_METHODS.codexImportPeekSession, "codexImport.peekSession");
    assert.strictEqual(WS_METHODS.codexImportImportSessions, "codexImport.importSessions");
  }),
);
