// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  ThreadManagementPostDispatchProjectionError,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { layer, OrchestratorMcpService } from "./OrchestratorMcpService.ts";

it.effect(
  "retains fresh accepted claims and releases unused replay claims after projection errors",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:mcp-attachment-cleanup");
      const threadId = ThreadId.make("thread:mcp-attachment-cleanup");
      const projection = {
        thread: {
          id: threadId,
          projectId,
          runtimeMode: "full-access",
          interactionMode: "default",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          deletedAt: null,
        },
        messages: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const dispatchReplayed = yield* Ref.make(false);
      const configLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-mcp-attachment-cleanup-",
      }).pipe(Layer.provide(NodeServices.layer));
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        configLayer,
        Layer.mock(ThreadManagementService)({
          getCommandReceipt: () => Effect.succeed(Option.none()),
          getThreadProjection: () => Effect.succeed(projection),
          sendToThread: (input) =>
            Ref.get(dispatchReplayed).pipe(
              Effect.flatMap((replayed) =>
                Effect.fail(
                  new ThreadManagementPostDispatchProjectionError({
                    projectId,
                    threadId,
                    messageId: input.messageId,
                    dispatchReplayed: replayed,
                    cause: new Error("projection unavailable after accepted dispatch"),
                  }),
                ),
              ),
            ),
        }),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: "codex",
            } as unknown as ServerProvider,
          ]),
        }),
        Layer.mock(ScheduledTaskService)({}),
      );
      const testLayer = layer.pipe(Layer.provideMerge(dependencies));

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService;
        const config = yield* ServerConfig.ServerConfig;
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-attachment-cleanup"),
          threadId,
          providerSessionId: "provider-session:mcp-attachment-cleanup",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const stage = (name: string) => {
          const id = createPendingAttachmentId();
          if (id === null) throw new Error("Expected a pending attachment id.");
          NodeFS.writeFileSync(
            NodePath.join(config.attachmentsDir, `${id}.png`),
            Buffer.from([1, 2, 3, 4]),
          );
          return {
            type: "image" as const,
            id: ChatAttachmentId.make(id),
            name,
            mimeType: "image/png",
            sizeBytes: 4,
          };
        };
        const claimedFiles = () =>
          NodeFS.readdirSync(config.attachmentsDir).filter(
            (entry) => !entry.startsWith("pending-"),
          );

        const freshError = yield* service
          .sendToThread(scope, {
            threadId,
            attachments: [stage("fresh.png")],
            clientRequestId: "fresh-accepted-claim",
          })
          .pipe(Effect.flip);
        expect(freshError.code).toBe("orchestration_error");
        expect(claimedFiles()).toHaveLength(1);

        yield* Ref.set(dispatchReplayed, true);
        const replayError = yield* service
          .sendToThread(scope, {
            threadId,
            attachments: [stage("replay.png")],
            clientRequestId: "replayed-accepted-claim",
          })
          .pipe(Effect.flip);
        expect(replayError.code).toBe("orchestration_error");
        expect(claimedFiles()).toHaveLength(1);
      }).pipe(Effect.provide(testLayer));
    }),
);
