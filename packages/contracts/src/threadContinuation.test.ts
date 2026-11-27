import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2Command,
  OrchestrationV2ImportedHistory,
  type OrchestrationV2ImportedHistoryMessage,
} from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";
import { ThreadContinueOnEnvironmentInput, ThreadReceiveInput } from "./threadContinuation.ts";

const message = (text: string): OrchestrationV2ImportedHistoryMessage => ({
  role: "user",
  text,
  createdAt: "2026-11-27T10:00:00.000Z",
});

const history = (messages: ReadonlyArray<OrchestrationV2ImportedHistoryMessage>) => ({
  messages,
  omittedCount: 0,
  source: { environmentId: "env-pc", threadId: "thread-src", title: "Fix login" },
});

const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: unknown) =>
  Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(value));

const isImportedHistory = Schema.is(OrchestrationV2ImportedHistory);
const decodeImportedHistory = Schema.decodeUnknownSync(OrchestrationV2ImportedHistory);

describe("thread continuation inputs", () => {
  it("round trips a continue request with a first message", () => {
    const input = {
      threadId: "thread-src",
      targetEnvironmentId: "env-mac",
      commitAndPush: true,
      message: "Run the tests",
    };
    expect(roundTrip(ThreadContinueOnEnvironmentInput, input)).toEqual(input);
  });

  it("round trips what the receiver gets, imported history included", () => {
    const input = {
      repository: {
        remoteUrl: "git@github.com:acme/app.git",
        canonicalKey: "github.com/acme/app",
      },
      remoteName: "origin",
      branch: "feat/login",
      title: "Fix login",
      importedHistory: {
        ...history([
          message("Why does login fail?"),
          { ...message("A bad token."), role: "assistant" },
        ]),
        omittedCount: 3,
      },
    };
    expect(roundTrip(ThreadReceiveInput, input)).toEqual(input);
  });

  it("decodes a newer sender's request id, and an input without the remote name", () => {
    const input = {
      repository: { remoteUrl: "git@github.com:me/app.git", canonicalKey: "github.com/me/app" },
      branch: "feat/login",
      title: "Fix login",
      importedHistory: history([message("Why does login fail?")]),
      requestId: "continue:0a1b",
    };
    expect(roundTrip(ThreadReceiveInput, input)).toEqual(input);
  });
});

describe("continue on another environment permissions", () => {
  const continueInput = (commitAndPush: boolean) => ({
    threadId: "thread-src",
    targetEnvironmentId: "env-mac",
    commitAndPush,
  });

  it("needs source control write to commit and push first", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.threadsContinueOnEnvironment, continueInput(true)),
    ).toEqual([AuthOrchestrationOperateScope, AuthSourceControlWriteScope]);
  });

  it("needs only orchestration operate to move pushed work", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.threadsContinueOnEnvironment, continueInput(false)),
    ).toEqual([AuthOrchestrationOperateScope]);
  });
});

describe("imported history caps", () => {
  it("accepts 200 messages and rejects 201", () => {
    expect(isImportedHistory(history(Array.from({ length: 200 }, () => message("hi"))))).toBe(true);
    expect(isImportedHistory(history(Array.from({ length: 201 }, () => message("hi"))))).toBe(
      false,
    );
  });

  it("counts UTF-8 bytes: 2,000,000 bytes pass and one more fails", () => {
    // "é" is two UTF-8 bytes, so the character count stays far under the cap.
    expect(isImportedHistory(history([message("é".repeat(1_000_000))]))).toBe(true);
    expect(isImportedHistory(history([message("é".repeat(1_000_000)), message("x")]))).toBe(false);
  });
});

describe("imported history source", () => {
  it("decodes a source from an older sender without a label", () => {
    expect(decodeImportedHistory(history([])).source.label).toBeUndefined();
  });

  it("decodes the label of the environment the thread came from", () => {
    const input = history([]);
    const decoded = decodeImportedHistory({ ...input, source: { ...input.source, label: "PC" } });
    expect(decoded.source.label).toBe("PC");
  });
});

const storedThread = {
  id: "thread-src",
  projectId: "project-1",
  title: "Fix login",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "thread-src", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-11-27T09:00:00.000Z",
  updatedAt: "2026-11-27T09:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
};
const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);

describe("thread continued-from link", () => {
  it("decodes a thread stored before threads could continue here", () => {
    expect(decodeThread(storedThread).continuedFrom).toBeUndefined();
  });

  it("decodes the link to the thread it came from", () => {
    const continuedFrom = {
      environmentId: "env-pc",
      threadId: "thread-src",
      title: "Fix login",
      label: "PC",
    };
    expect(decodeThread({ ...storedThread, continuedFrom }).continuedFrom).toEqual({
      environmentId: "env-pc",
      threadId: "thread-src",
      title: "Fix login",
      label: "PC",
    });
  });
});

describe("thread moved marker", () => {
  it("decodes a thread stored before threads could move", () => {
    expect(decodeThread(storedThread).movedTo).toBeUndefined();
  });

  it("decodes the marker with its time", () => {
    const movedTo = {
      environmentId: "env-mac",
      threadId: "thread-dst",
      title: "Fix login",
      label: "Mac",
      movedAt: "2026-11-27T10:00:00.000Z",
    };
    const decoded = decodeThread({ ...storedThread, movedTo }).movedTo;
    expect(decoded?.label).toBe("Mac");
    expect(decoded && DateTime.formatIso(decoded.movedAt)).toBe("2026-11-27T10:00:00.000Z");
  });
});

describe("thread.moved commands", () => {
  const decodeClientCommand = Schema.decodeUnknownExit(OrchestrationV2Command);
  const movedTo = {
    environmentId: "env-mac",
    threadId: "thread-dst",
    title: "Fix login",
    label: "Mac",
    movedAt: DateTime.makeUnsafe("2026-11-27T10:00:00.000Z"),
  };

  it("does not let a client set the marker", () => {
    const exit = decodeClientCommand({
      type: "thread.moved.set",
      commandId: "command-1",
      threadId: "thread-src",
      movedTo,
    });
    expect(exit._tag).toBe("Failure");
  });

  it("lets a client clear the marker", () => {
    const exit = decodeClientCommand({
      type: "thread.moved.clear",
      commandId: "command-2",
      threadId: "thread-src",
    });
    expect(exit._tag).toBe("Success");
  });
});
