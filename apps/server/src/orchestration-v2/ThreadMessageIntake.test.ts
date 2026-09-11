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
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { dispatchCommand } from "./ThreadMessageIntake.ts";

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
    }).pipe(
      Effect.provide(
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
        }),
      ),
      Effect.result,
    );
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
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-question-intake-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
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
    }).pipe(
      Effect.provide(
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
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("AttachmentClaimError");
    }
    expect(captured).toHaveLength(0);
    expect(NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${existingId}.png`))).toEqual(
      Buffer.from([9, 9, 9, 9]),
    );
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-q-fail-"),
      ),
    ).toEqual([`${existingId}.png`]);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-question-intake-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect(
  "rolls back earlier question claims when a later claimed attachment path is missing",
  () =>
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
      }).pipe(
        Effect.provide(
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
          }),
        ),
        Effect.result,
      );
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
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-question-intake-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
