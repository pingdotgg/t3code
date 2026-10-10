import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  SnapShotAccessibility,
} from "./chatAttachment.ts";
import {
  OrchestrationV2Command,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2ThreadLaunchInput,
} from "./orchestrationV2.ts";
import { ProviderRespondToUserInputInput, ProviderSendTurnInput } from "./provider.ts";
import { UserInputAttachmentAnswerPayload } from "./providerPolicy.ts";

const decodeAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const decodeSnapShotAccessibility = Schema.decodeUnknownEffect(SnapShotAccessibility);
const decodeQuestionAnswer = Schema.decodeUnknownSync(UserInputAttachmentAnswerPayload);
const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);

it.each([
  ["provider turn", ProviderSendTurnInput, {}],
  [
    "provider question response",
    ProviderRespondToUserInputInput,
    { requestId: "request-1", answers: {} },
  ],
  [
    "message dispatch",
    OrchestrationV2Command,
    {
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      messageId: "message-1",
      text: "hello",
      dispatchMode: { type: "start_immediately" },
    },
  ],
  [
    "queued message edit",
    OrchestrationV2Command,
    { type: "queued-run.edit", runId: "run-1", text: "hello" },
  ],
  [
    "runtime question response",
    OrchestrationV2Command,
    { type: "runtime-request.respond", requestId: "request-1", answers: {} },
  ],
  [
    "thread launch",
    OrchestrationV2ThreadLaunchInput,
    {
      projectId: "project-1",
      title: "Thread",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    },
  ],
] as const)("caps new file attachments in %s", (name, schema, fields) => {
  const input = (sizeBytes: number) => {
    const attachments = [
      { type: "file", id: "file-1", name: "report.pdf", mimeType: "application/pdf", sizeBytes },
    ];
    return {
      commandId: "command-1",
      threadId: "thread-1",
      ...fields,
      ...(name === "thread launch"
        ? { initialMessage: { text: "hello", attachments } }
        : name.includes("question response")
          ? { attachmentsByQuestionId: { question: attachments } }
          : { attachments }),
    };
  };
  assert.strictEqual(Schema.is(schema)(input(PROVIDER_SEND_TURN_MAX_FILE_BYTES)), true);
  assert.strictEqual(Schema.is(schema)(input(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1)), false);
});

it("reads historical question replies with files above the send limit", () => {
  const payload = decodeQuestionAnswer({
    requestId: "request-1",
    answers: {},
    attachmentsByQuestionId: {
      question: [
        {
          type: "file",
          id: "file-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
        },
      ],
    },
  });
  assert.strictEqual(
    payload.attachmentsByQuestionId.question?.[0]?.sizeBytes,
    PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
  );
});

it("reads complete historical messages with files above the send limit", () => {
  const message = decodeMessage({
    id: "message-1",
    threadId: "thread-1",
    runId: null,
    nodeId: null,
    createdBy: "user",
    creationSource: "web",
    role: "user",
    text: "hello",
    streaming: false,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    attachments: [
      {
        type: "file",
        id: "file-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
      },
    ],
  });
  assert.strictEqual(message.attachments[0]?.sizeBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1);
  assert.strictEqual(message.text, "hello");
});

// Attachments ride on persisted events and thread streams with no client
// version negotiation. A type this build does not know must decode instead of
// failing the whole message.
it.effect("tolerates attachment types from newer builds", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeAttachment({
      type: "somethingnew",
      id: "thread-1-00000000-0000-4000-8000-000000000003-glb",
      name: "scene.glb",
      mimeType: "model/gltf-binary",
      sizeBytes: 12,
    });
    assert.strictEqual(attachment.type, "somethingnew");
  }),
);

it.effect("rejects malformed known attachment types instead of tolerating them", () =>
  Effect.gen(function* () {
    const base = {
      id: "thread-1-00000000-0000-4000-8000-000000000003-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
    };
    // A newer build may raise the upload cap; this build must still read those files.
    const aboveUploadCap = PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1;
    const largeFile = yield* decodeAttachment({ ...base, type: "file", sizeBytes: aboveUploadCap });
    assert.strictEqual(largeFile.sizeBytes, aboveUploadCap);

    const emptyFile = yield* Effect.exit(decodeAttachment({ ...base, type: "file", sizeBytes: 0 }));
    assert.strictEqual(Exit.isFailure(emptyFile), true);
    const badMimeImage = yield* Effect.exit(
      decodeAttachment({ ...base, type: "image", mimeType: "application/pdf", sizeBytes: 12 }),
    );
    assert.strictEqual(Exit.isFailure(badMimeImage), true);
  }),
);

it.effect("rejects accessibility trees above the serialized payload limit", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeSnapShotAccessibility({
        format: "element-tree",
        coordinateSpace: "captured-image",
        imageSize: { width: 800, height: 600 },
        truncated: false,
        root: {
          role: "window",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: Array.from({ length: 10 }, () => ({
            role: "text",
            value: "x".repeat(8_000),
            bounds: null,
            children: [],
          })),
        },
      }),
    );

    assert.strictEqual(Exit.isFailure(result), true);
  }),
);

it("isProviderSendTurnSupportedImageMimeType accepts raster formats and rejects svg", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/png"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/svg+xml"), false);
});
