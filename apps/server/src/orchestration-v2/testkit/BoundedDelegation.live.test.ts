import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import { makeGrokAdapterV2 } from "@t3tools/provider-grok/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ThreadLaunchService from "../ThreadLaunchService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import * as Cause from "effect/Cause";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CodexSettings,
  EnvironmentId,
  ProviderDriverKind,
  OrchestratorMcpDelegateTaskInput,
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

const decodeDelegateTask = Schema.decodeEffect(OrchestratorMcpDelegateTaskInput);
const decodeGrokSettings = Schema.decodeEffect(GrokSettings);
const decodeSettings = Schema.decodeEffect(CodexSettings);

const restrictedGrokParent = process.env.T3_GROK_RESTRICTED_PARENT_E2E === "1";
const grok = process.env.T3_UNRESTRICTED_GROK_E2E === "1" || restrictedGrokParent;
const live = describe.runIf(process.env.T3_BOUNDED_CODEX_E2E === "1" || grok);
live("live noninteractive delegation", () => {
  it.live(
    "preserves the inherited access policy for child and grandchild without approval waits",
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
              ...(grok
                ? []
                : [
                    "try:",
                    " pathlib.Path(outside).write_text('forbidden')",
                    " blocked=False",
                    "except PermissionError as error:",
                    " blocked=error.errno in (errno.EACCES,errno.EPERM)",
                    "pathlib.Path(name+'.json').write_text(json.dumps({'allowed':True,'outsideDenied':blocked}))",
                    "assert blocked, 'outside write escaped inherited limits'",
                  ]),
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
          const parentId = ThreadId.make("bounded-live-parent");
          const parentSandbox =
            grok && !restrictedGrokParent
              ? { type: "dangerFullAccess" as const, networkAccess: true as const }
              : ({
                  type: "workspaceWrite",
                  writableRoots: [],
                  networkAccess: false,
                  excludeSlashTmp: true,
                  excludeTmpdirEnvVar: true,
                } as const);
          const openedSessions = new Set<ThreadId>();
          const nativeFactory = yield* Effect.service(Codex.CodexAppServerClientFactory).pipe(
            Effect.provide(factoryContext),
          );
          const allocator = yield* IdAllocator.IdAllocatorV2;
          const adapter = yield* Codex.makeCodexAdapterV2({
            instanceId: ProviderInstanceId.make("codex"),
            settings: yield* decodeSettings({ homePath }),
            environment: process.env,
            clientFactory: {
              open: Effect.fn("boundedLive.openSession")(function* (
                input: Parameters<Codex.CodexAppServerClientFactoryShape["open"]>[0],
              ) {
                openedSessions.add(input.threadId);
                return yield* nativeFactory.open(input);
              }),
            },
            crypto: yield* Crypto.Crypto,
            fileSystem: fs,
            idAllocator: allocator,
            serverConfig,
          });
          const parentOnlyPolicy = Layer.effect(
            RuntimePolicy.RuntimePolicyV2,
            Effect.gen(function* () {
              const base = yield* RuntimePolicy.RuntimePolicyV2;
              return RuntimePolicy.RuntimePolicyV2.of({
                resolve: (input) =>
                  base.resolve(input).pipe(
                    Effect.map((policy) =>
                      input.thread.id === parentId
                        ? {
                            ...policy,
                            approvalPolicy: "on-request",
                            sandboxPolicy: parentSandbox,
                          }
                        : policy,
                    ),
                  ),
              });
            }),
          ).pipe(Layer.provide(RuntimePolicy.layer));
          const model = process.env.T3_BOUNDED_CODEX_MODEL ?? "gpt-6.1-sol";
          const grokHome = process.env.T3_UNRESTRICTED_GROK_HOME;
          if (grok && (grokHome === undefined || !path.isAbsolute(grokHome)))
            return yield* Effect.die(
              "Set T3_UNRESTRICTED_GROK_HOME to an isolated authenticated Grok home with a Bash(touch *) deny rule and ambient skill discovery disabled.",
            );
          const grokInstance = ProviderInstanceId.make("grok");
          const grokModel = process.env.T3_UNRESTRICTED_GROK_MODEL ?? "grok-4.7";
          const grokAdapter = grok
            ? yield* makeGrokAdapterV2({
                instanceId: grokInstance,
                settings: yield* decodeGrokSettings({}),
                environment: { ...process.env, GROK_HOME: grokHome },
                hostPlatform: yield* HostProcess.Platform,
                selfInvocation: yield* resolveSelfInvocation(),
              }).pipe(
                Effect.provide(
                  TestProviderHost.layer({ cwd }).pipe(Layer.provide(NodeServices.layer)),
                ),
              )
            : undefined;
          const registryLayer = Registry.layerFromAdaptersEffect(
            Effect.succeed(
              grokAdapter === undefined
                ? [adapter]
                : [
                    adapter,
                    {
                      ...grokAdapter,
                      openSession: Effect.fn("grokLive.openSession")(function* (
                        input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
                      ) {
                        openedSessions.add(input.threadId);
                        return yield* grokAdapter.openSession(input);
                      }),
                    },
                  ],
            ),
          );
          const runtime = Harness.layerWithRegistry(
            { name: "bounded-delegation-live" },
            registryLayer,
            { runtimePolicyLayer: parentOnlyPolicy },
          );

          const management = ThreadManagementService.layer.pipe(
            Layer.provide(runtime),
            Layer.provide(
              ServerSettings.layerTest(
                grok
                  ? {
                      providerInstances: {
                        [ProviderInstanceId.make("codex")]: { driver: "codex", enabled: true },
                        [grokInstance]: { driver: "grok", enabled: true },
                      },
                    }
                  : {},
              ),
            ),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          );
          const apiLayer = OrchestratorMcpService.layer.pipe(
            Layer.provide(management),
            Layer.provide(registryLayer),
            Layer.provide(
              ProviderRegistryMock.layer([
                {
                  instanceId: ProviderInstanceId.make("codex"),
                  driver: ProviderDriverKind.make("codex"),
                  enabled: true,
                  installed: true,
                  version: "live",
                  status: "ready",
                  auth: { status: "authenticated" },
                  checkedAt: "2026-11-01T00:00:00.000Z",
                  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
                  slashCommands: [],
                  skills: [],
                },
                ...(grok
                  ? [
                      {
                        instanceId: grokInstance,
                        driver: ProviderDriverKind.make("grok"),
                        enabled: true,
                        installed: true,
                        version: "live",
                        status: "ready" as const,
                        auth: { status: "authenticated" as const },
                        checkedAt: "2026-11-01T00:00:00.000Z",
                        models: [
                          {
                            slug: grokModel,
                            name: grokModel,
                            isCustom: false,
                            capabilities: null,
                          },
                        ],
                        slashCommands: [],
                        skills: [],
                      },
                    ]
                  : []),
              ]),
            ),
            Layer.provide(
              ServerSettings.layerTest(
                grok
                  ? {
                      providerInstances: {
                        [ProviderInstanceId.make("codex")]: { driver: "codex", enabled: true },
                        [grokInstance]: { driver: "grok", enabled: true },
                      },
                    }
                  : {},
              ),
            ),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
                Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(RemoteDelegation.RemoteDelegation)({}),
              ),
            ),
            Layer.provideMerge(runtime),
          );

          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const selection = {
              instanceId: ProviderInstanceId.make("codex"),
              model,
              options: [{ id: "reasoningEffort", value: "low" }],
            };
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("bounded-parent-create"),
              threadId: parentId,
              projectId: ProjectId.make("bounded-live-project"),
              title: "Bounded live parent",
              modelSelection: selection,
              runtimeMode: grok ? "full-access" : "auto",
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
            const dispatchTask = Effect.fn("boundedLive.dispatchTask")(function* (
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
                runtimeMode: grok ? "full-access" : "auto",
                interactionMode: "default",
                approvalPolicy: "never",
                createdBy: "agent",
                creationSource: "mcp",
                ...overrides,
              });
            });
            const openedBefore = openedSessions.size;
            const rejected = yield* dispatchTask(parentId, "unsupported-worktree", {
              workspaceStrategy: { type: "worktree", baseRef: "HEAD", startFromOrigin: false },
            }).pipe(Effect.exit);
            assert.equal(rejected._tag, "Failure");
            if (rejected._tag === "Failure")
              assert.include(Cause.pretty(rejected.cause), "Bounded delegation requires");
            assert.equal(openedSessions.size, openedBefore);
            const absent = yield* orchestrator
              .getThreadProjection(
                allocator.derive.delegatedTaskThread({
                  commandId: CommandId.make("bounded-unsupported-worktree"),
                }),
              )
              .pipe(Effect.exit);
            assert.equal(absent._tag, "Failure");
            assert.lengthOf((yield* orchestrator.getThreadProjection(parentId)).subagents, 0);
            const api = yield* OrchestratorMcpService.OrchestratorMcpService;
            const parentScope: McpInvocationScope = {
              environmentId: EnvironmentId.make("bounded-live"),
              requestNamespace: "bounded-parent",
              issuedAt: 0,
              thread: {
                threadId: parentId,
                providerSessionId: "bounded-parent",
                providerInstanceId: selection.instanceId,
              },
              client: undefined,
              capabilities: new Set(["orchestration"]),
            };
            for (const { expected, ...request } of [
              { isolation: "worktree", expected: "invalid_request" },
              {
                target: { environmentId: EnvironmentId.make("other-environment") },
                expected: "invalid_request",
              },
              ...(grok
                ? []
                : [
                    {
                      runtimeMode: "full-access" as const,
                      expected: "runtime_mode_escalation_denied",
                    },
                  ]),
              {
                target: { providerInstanceId: ProviderInstanceId.make("unsupported") },
                expected: "provider_unavailable",
              },
            ] as const) {
              const error = yield* api
                .delegateTask(
                  parentScope,
                  yield* decodeDelegateTask({
                    task: "Must not dispatch",
                    approvalPolicy: "never",
                    ...request,
                  }),
                )
                .pipe(Effect.flip);
              assert.equal(error.code, expected);
            }
            const unsupportedProviderStartups = openedSessions.size - openedBefore;
            assert.equal(unsupportedProviderStartups, 0);
            assert.lengthOf((yield* orchestrator.getThreadProjection(parentId)).subagents, 0);
            const delegate = Effect.fn("boundedLive.delegateTaskApi")(function* (
              threadId: ThreadId,
              name: string,
              approvalPolicy: "inherit" | "never" = "never",
            ) {
              const current = yield* orchestrator.getThreadProjection(threadId);
              const scope: McpInvocationScope = {
                environmentId: EnvironmentId.make("bounded-live"),
                requestNamespace: `bounded-${threadId}`,
                issuedAt: 0,
                thread: {
                  threadId,
                  providerSessionId: `bounded-${threadId}`,
                  providerInstanceId: current.thread.providerInstanceId,
                },
                client: undefined,
                capabilities: new Set(["orchestration"]),
              };
              const result = yield* api.delegateTask(
                scope,
                yield* decodeDelegateTask({
                  task: grok
                    ? `Use the shell tool to run python3 probe.py ${name} ${JSON.stringify(outside)} in ${cwd}. Then separately attempt touch ${JSON.stringify(outside)}. A configured deny rule should reject touch. Do not substitute commands. Then return only PASS. This is a disposable fixture.`
                    : `Run exactly one command using exec_command in ${cwd}: python3 probe.py ${name} ${JSON.stringify(outside)}. This checks disposable files. Do not request escalation. Then return only PASS.`,
                  approvalPolicy,
                  target: {
                    environmentId: scope.environmentId,
                    ...(grok
                      ? {
                          providerInstanceId: grokInstance,
                          model: grokModel,
                          options: { reasoningEffort: "low" },
                        }
                      : {}),
                  },
                  mode: "async",
                  clientRequestId: name,
                }),
              );
              if (result.childThreadId === null)
                return yield* Effect.die("Expected a local child.");
              return result.childThreadId;
            });
            if (restrictedGrokParent) {
              const rejected = yield* delegate(parentId, "rejected").pipe(Effect.exit);
              assert.equal(rejected._tag, "Failure");
              if (rejected._tag === "Failure")
                assert.include(
                  Cause.pretty(rejected.cause),
                  "Failed to dispatch orchestration command delegated_task.request",
                );
              const direct = yield* dispatchTask(parentId, "restricted-direct", {
                modelSelection: { instanceId: grokInstance, model: grokModel },
              }).pipe(Effect.exit);
              assert.equal(direct._tag, "Failure");
              if (direct._tag === "Failure")
                assert.include(
                  Cause.pretty(direct.cause),
                  "Grok noninteractive delegation requires verified unrestricted parent access",
                );
              assert.equal(openedSessions.size, openedBefore);
              assert.lengthOf((yield* orchestrator.getThreadProjection(parentId)).subagents, 0);
              yield* fs.writeFileString(
                path.join(homePath, "grok-restricted-parent-receipt.json"),
                JSON.stringify({
                  date: "2026-11-01",
                  dispatchPath: "OrchestratorMcpService.delegateTask",
                  rejected: true,
                  childStartups: 0,
                  parentSandbox,
                }),
              );
              return;
            }
            const childId = yield* delegate(parentId, "child");
            const ceiling = (yield* orchestrator.getThreadProjection(childId)).thread
              .delegatedExecution;
            assert.deepEqual(ceiling, {
              providerInstanceId: grok ? grokInstance : selection.instanceId,
              cwd,
              sandboxPolicy: grok
                ? { type: "dangerFullAccess", networkAccess: true }
                : parentSandbox,
            });
            yield* running(childId);
            const grandchildId = yield* delegate(childId, "grandchild", "inherit");
            assert.deepEqual(
              (yield* orchestrator.getThreadProjection(grandchildId)).thread.delegatedExecution,
              ceiling,
            );
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
                projection.runtimeRequests.filter((request) => request.kind !== "user_input"),
                0,
              );
              assert.lengthOf(
                projection.turnItems.filter((item) => item.type === "approval_request"),
                0,
              );
              if (grok)
                assert.isTrue(
                  projection.turnItems.some(
                    (item) =>
                      item.type === "command_execution" &&
                      item.input.includes("touch ") &&
                      item.output?.includes("Denied by permission policy"),
                  ),
                  "Native Grok must attempt the forbidden command and report its policy denial.",
                );
              if (grok)
                assert.equal(yield* fs.readFileString(path.join(cwd, `${name}.txt`)), "allowed");
              else
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
                dispatchPath: "OrchestratorMcpService.delegateTask",
                cwd,
                childId,
                grandchildId,
                ceiling,
                allowed: true,
                outsideDenied: !grok,
                deniedCommandBlocked: grok,
                filesystemConfinement: !grok,
                approvalRequestsEver: 0,
                pendingApprovals: 0,
                parentOnlyRestrictions: true,
                unsupportedProviderStartups,
              }),
            );
          }).pipe(Effect.provide(apiLayer));
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
  );
});
