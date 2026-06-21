import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ExecutionRunContinueRequest,
  ExecutionRunCreateRequest,
  TaskRuntimeMaterializeRequest,
} from "./executionBridge.ts";

const decodeCreateRequest = Schema.decodeUnknownSync(ExecutionRunCreateRequest);
const decodeContinueRequest = Schema.decodeUnknownSync(ExecutionRunContinueRequest);
const decodeMaterializeRequest = Schema.decodeUnknownSync(TaskRuntimeMaterializeRequest);

describe("Execution bridge contracts", () => {
  it("accepts optional native image attachments on bridge requests", () => {
    const attachment = {
      type: "image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 4,
      dataUrl: "data:image/png;base64,dGVzdA==",
    };

    expect(
      decodeCreateRequest({
        controlThreadId: "task-1",
        executionRunId: "run-1",
        initialPrompt: "Inspect this screenshot",
        attachments: [attachment],
        workspaceRoot: "C:\\repo",
      }).attachments,
    ).toEqual([attachment]);

    expect(
      decodeContinueRequest({
        controlThreadId: "task-1",
        executionRunId: "run-1",
        t3ThreadId: "thread-1",
        prompt: "Follow up",
        attachments: [attachment],
      }).attachments,
    ).toEqual([attachment]);

    expect(
      decodeMaterializeRequest({
        taskId: "task-1",
        workSessionId: "session-1",
        initialPrompt: "Inspect this screenshot",
        attachments: [attachment],
        project: {
          repoName: "example-app",
          workspaceRoot: "C:\\repo",
          defaultBranch: "dev",
        },
        title: "Inspect screenshot",
      }).attachments,
    ).toEqual([attachment]);
  });
});
