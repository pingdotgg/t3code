import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CodexSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Crypto from "effect/Crypto";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Codex from "../Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import * as Harness from "./ProviderReplayHarness.ts";

const decodeSettings = Schema.decodeEffect(CodexSettings);

describe.runIf(process.env.T3_BOUNDED_CODEX_E2E === "1")("live bounded Codex delegation", () => {
  it.live(
    "keeps child and grandchild inside the effective parent sandbox without approval waits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homePath = process.env.T3_BOUNDED_CODEX_HOME;
          if (homePath === undefined || !path.isAbsolute(homePath))
            return yield* Effect.die(
              "Set T3_BOUNDED_CODEX_HOME to an isolated authenticated Codex home.",
            );
          const cwd = yield* checkpointWorkspace("bounded-delegation-live");
          const outside = path.join(path.dirname(cwd), `${path.basename(cwd)}-denied.txt`);
          assert.isFalse(yield* fs.exists(outside));
          yield* fs.writeFileString(outside, "parent control");
          yield* fs.remove(outside);
          yield* fs.writeFileString(
            path.join(cwd, "probe.py"),
            [
              "import errno,json,pathlib,sys",
              "name,outside=sys.argv[1:]",
              "pathlib.Path(name+'.txt').write_text('allowed')",
              "try:",
              " pathlib.Path(outside).write_text('forbidden')",
              " blocked=False",
              "except PermissionError as error:",
              " blocked=error.errno in (errno.EACCES,errno.EPERM)",
              "pathlib.Path(name+'.json').write_text(json.dumps({'allowed':True,'outsideDenied':blocked}))",
              "assert blocked, 'outside write escaped inherited limits'",
            ].join("\n"),
          );
          const serverConfig = yield* Harness.makeReplayServerConfig("bounded-delegation-live");
          const factoryContext = yield* Layer.build(
            Codex.layerAppServerClientFactory.pipe(
              Layer.provide(
                Layer.succeed(
                  ProviderEventLoggers.ProviderEventLoggers,
                  ProviderEventLoggers.NoOpProviderEventLoggers,
                ),
              ),
              Layer.provide(NodeServices.layer),
            ),
          );
          const adapter = yield* Codex.makeCodexAdapterV2({
            instanceId: ProviderInstanceId.make("codex"),
            settings: yield* decodeSettings({ homePath }),
            environment: process.env,
            clientFactory: yield* Effect.service(Codex.CodexAppServerClientFactory).pipe(
              Effect.provide(factoryContext),
            ),
            crypto: yield* Crypto.Crypto,
            fileSystem: fs,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            serverConfig,
          });
          const runtime = Harness.layerWithRegistry(
            {
              name: "bounded-delegation-live",
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "on-request",
                sandboxPolicy: {
                  type: "workspaceWrite",
                  writableRoots: [],
                  networkAccess: false,
                  excludeSlashTmp: true,
                  excludeTmpdirEnvVar: true,
                },
              },
            },
            Registry.layerFromAdaptersEffect(Effect.succeed([adapter])),
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const parentId = ThreadId.make("bounded-live-parent");
            const selection = {
              instanceId: ProviderInstanceId.make("codex"),
              model: process.env.T3_BOUNDED_CODEX_MODEL ?? "gpt-6.1-sol",
              options: [{ id: "reasoningEffort", value: "low" }],
            };
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("bounded-parent-create"),
              threadId: parentId,
              projectId: ProjectId.make("bounded-live-project"),
              title: "Bounded live parent",
              modelSelection: selection,
              runtimeMode: "auto",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            const created = yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("bounded-parent-start"),
              threadId: parentId,
              messageId: MessageId.make("bounded-parent-message"),
              text: "Write a detailed 2000 word explanation of Unix filesystem permissions. Do not use tools. This is a disposable integration test.",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
            });
            const running = (threadId: ThreadId, afterSequence = 0) =>
              orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "provider-turn.updated" &&
                    stored.event.payload.status === "running",
                ),
                Stream.runHead,
                Effect.flatMap((event) =>
                  Option.isSome(event) ? Effect.void : Effect.die("Native turn did not start."),
                ),
              );
            yield* running(parentId, created.sequence);
            const delegate = Effect.fn("boundedLive.delegate")(function* (
              threadId: ThreadId,
              name: string,
              overrides: Partial<
                Extract<OrchestrationV2Command, { type: "delegated_task.request" }>
              > = {},
            ) {
              const projection = yield* orchestrator.getThreadProjection(threadId);
              const run = projection.runs.at(-1);
              if (run === undefined || run.rootNodeId === null)
                return yield* Effect.die("Parent run is no longer active.");
              return yield* orchestrator.dispatch({
                type: "delegated_task.request",
                commandId: CommandId.make(`bounded-${name}`),
                parentThreadId: threadId,
                parentRunId: run.id,
                parentNodeId: run.rootNodeId,
                task: `Run exactly one command using exec_command in ${cwd}: python3 probe.py ${name} ${JSON.stringify(outside)}. This checks disposable files. Do not request escalation. Then return only PASS.`,
                modelSelection: selection,
                runtimeMode: "auto",
                interactionMode: "default",
                approvalPolicy: "never",
                createdBy: "agent",
                creationSource: "mcp",
                ...overrides,
              });
            });
            const rejected = yield* delegate(parentId, "unsupported-worktree", {
              workspaceStrategy: { type: "worktree", baseRef: "HEAD", startFromOrigin: false },
            }).pipe(Effect.exit);
            assert.equal(rejected._tag, "Failure");
            assert.lengthOf((yield* orchestrator.getThreadProjection(parentId)).subagents, 0);
            const childResult = yield* delegate(parentId, "child");
            const childEvent = childResult.storedEvents.find(
              (stored) => stored.event.type === "thread.created",
            );
            if (childEvent?.event.type !== "thread.created")
              return yield* Effect.die("No committed child thread.");
            const childId = childEvent.event.payload.id;
            const ceiling = childEvent.event.payload.delegatedExecution;
            assert.isDefined(ceiling);
            yield* running(childId);
            const grandchildResult = yield* delegate(childId, "grandchild", {
              approvalPolicy: "inherit",
            });
            const grandchildEvent = grandchildResult.storedEvents.find(
              (stored) => stored.event.type === "thread.created",
            );
            if (grandchildEvent?.event.type !== "thread.created")
              return yield* Effect.die("No committed grandchild thread.");
            const grandchildId = grandchildEvent.event.payload.id;
            assert.deepEqual(grandchildEvent.event.payload.delegatedExecution, ceiling);
            const finish = (threadId: ThreadId) =>
              orchestrator.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "run.updated" &&
                    ["completed", "failed", "cancelled"].includes(stored.event.payload.status),
                ),
                Stream.runHead,
                Effect.flatMap((event) =>
                  Option.isSome(event) ? Effect.void : Effect.die("No terminal run."),
                ),
              );
            yield* finish(grandchildId);
            yield* finish(childId);
            for (const [name, threadId] of [
              ["child", childId],
              ["grandchild", grandchildId],
            ] as const) {
              const projection = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(projection.runs.at(-1)?.status, "completed");
              assert.lengthOf(
                projection.runtimeRequests.filter(
                  (request) => request.status === "pending" && request.kind !== "user_input",
                ),
                0,
              );
              assert.deepEqual(
                JSON.parse(yield* fs.readFileString(path.join(cwd, `${name}.json`))),
                { allowed: true, outsideDenied: true },
              );
            }
            assert.isFalse(yield* fs.exists(outside));
            yield* fs.writeFileString(
              path.join(homePath, "bounded-delegation-receipt.json"),
              JSON.stringify({
                test: "bounded-delegation",
                cwd,
                childId,
                grandchildId,
                ceiling,
                allowed: true,
                outsideDenied: true,
                pendingApprovals: 0,
              }),
            );
          }).pipe(Effect.provide(runtime));
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
    180_000,
  );
});
