// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { OrchestratorCommandRejectedError, OrchestratorDispatchError } from "./Orchestrator.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { dispatchCommand } from "./ThreadMessageIntake.ts";

const intakeTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-question-intake-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const failingDispatch = (captured: OrchestrationV2Command[]) =>
  Layer.mock(ThreadManagementService)({
    dispatch: (command) => {
      captured.push(command);
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Stop after intake",
        }),
      );
    },
  });

it.effect("claims question uploads and passes readable paths through the V2 request command", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const id = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2Command[] = [];
    yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-1"),
      threadId: ThreadId.make("thread-answer"),
      requestId: RuntimeRequestId.make("request-1"),
      answers: { q: ["Selected option"] },
      attachmentsByQuestionId: {
        q: [{ type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 }],
      },
    }).pipe(Effect.provide(failingDispatch(captured)), Effect.result);
    expect(captured).toHaveLength(1);
    const command = captured[0]!;
    expect(command.type).toBe("runtime-request.respond");
    if (command.type !== "runtime-request.respond") return;
    const attachment = command.attachmentsByQuestionId?.q?.[0];
    expect(attachment).toBeDefined();
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: attachment!,
    });
    expect(path).not.toBeNull();
    expect(NodeFS.readFileSync(path!)).toEqual(Buffer.from([1, 2, 3]));
    expect(command.answers?.q).toEqual([
      "Selected option",
      `Attached image "screen.png": "${path}"`,
    ]);
  }).pipe(Effect.provide(intakeTestLayer)),
);

it.effect("rolls back earlier question claims when a later pending upload is missing", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-q-fail");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    const existingId = ChatAttachmentId.make("thread-q-fail-00000000-0000-4000-8000-000000000001");
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${existingId}.png`),
      new Uint8Array([9, 9, 9, 9]),
    );
    const captured: OrchestrationV2Command[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-missing-pending"),
      threadId,
      requestId: RuntimeRequestId.make("request-missing-pending"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: existingId,
            name: "keep.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: ChatAttachmentId.make(createPendingAttachmentId()!),
            name: "gone.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(failingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("AttachmentClaimError");
    }
    expect(captured).toHaveLength(0);
    // The pending sources stay behind so the user can retry the response.
    expect(NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    // The pre-existing thread attachment is retained; only the new copy is rolled back.
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-q-fail-"),
      ),
    ).toEqual([`${existingId}.png`]);
  }).pipe(Effect.provide(intakeTestLayer)),
);

it.effect("rolls back earlier question claims when attachment path preparation fails", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2Command[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-missing-claimed"),
      threadId: ThreadId.make("thread-path-fail"),
      requestId: RuntimeRequestId.make("request-missing-claimed"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: ChatAttachmentId.make("thread-path-fail-00000000-0000-4000-8000-000000000099"),
            name: "missing.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(failingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("AttachmentClaimError");
    }
    expect(captured).toHaveLength(0);
    expect(NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-path-fail-"),
      ),
    ).toEqual([]);
  }).pipe(Effect.provide(intakeTestLayer)),
);

it.effect("retains claimed copies when dispatch failure may have been accepted", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2Command[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-ambiguous"),
      threadId: ThreadId.make("thread-ambiguous"),
      requestId: RuntimeRequestId.make("request-ambiguous"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(failingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    expect(captured).toHaveLength(1);
    // The response may have been accepted before the error, so the copy that
    // backs the answer's path stays for the provider to read.
    const threadFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
      entry.startsWith("thread-ambiguous-"),
    );
    expect(threadFiles).toHaveLength(1);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(intakeTestLayer)),
);

it.effect("releases claimed copies when dispatch rejects the command before commit", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-rejected"),
      threadId: ThreadId.make("thread-rejected"),
      requestId: RuntimeRequestId.make("request-rejected"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService)({
          dispatch: (command) =>
            Effect.fail(
              new OrchestratorCommandRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                cause: "rejected in test",
              }),
            ),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-rejected-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(intakeTestLayer)),
);

it.effect("a retried response re-claims the preserved pending uploads", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-retry");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    const lateId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const command: OrchestrationV2Command = {
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-retry"),
      threadId,
      requestId: RuntimeRequestId.make("request-retry"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: lateId,
            name: "late.png",
            mimeType: "image/png",
            sizeBytes: 2,
          },
        ],
      },
    };
    const captured: OrchestrationV2Command[] = [];
    const first = yield* dispatchCommand(command).pipe(
      Effect.provide(failingDispatch(captured)),
      Effect.result,
    );
    expect(first._tag).toBe("Failure");
    expect(captured).toHaveLength(0);

    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${lateId}.png`),
      new Uint8Array([7, 7]),
    );
    const retry = yield* dispatchCommand(command).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService)({
          dispatch: (dispatched) => {
            captured.push(dispatched);
            return Effect.succeed({ sequence: 1, storedEvents: [] });
          },
        }),
      ),
      Effect.result,
    );
    expect(retry._tag).toBe("Success");
    const dispatched = captured[0]!;
    expect(dispatched.type).toBe("runtime-request.respond");
    if (dispatched.type !== "runtime-request.respond") return;
    for (const attachment of [
      ...(dispatched.attachmentsByQuestionId?.q1 ?? []),
      ...(dispatched.attachmentsByQuestionId?.q2 ?? []),
    ]) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      expect(path).not.toBeNull();
      expect(NodeFS.existsSync(path!)).toBe(true);
    }
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-retry-"),
      ),
    ).toHaveLength(2);
  }).pipe(Effect.provide(intakeTestLayer)),
);
