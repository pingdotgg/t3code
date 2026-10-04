import { randomUUID } from "node:crypto";

import { Effect, Option } from "effect";

import { ServerConfig } from "../../../config.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import {
  associatePullRequestTool,
  createIsolatedWorkspaceTool,
  delegateWorkTool,
  linkPullRequestTool,
  listThreadPullRequestsTool,
  reportToParentTool,
  resolveMcpCliInvocation,
  sendToThreadTool,
  setChildWaitTool,
  switchWorkspaceTool,
  unlinkPullRequestTool,
  withNestedThreadAudit,
  type McpServeOptions,
} from "../../../mcpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

import { DelegationToolkit, DelegationToolError } from "./tools.ts";

const toolError = (message: string) => new DelegationToolError({ message });

/**
 * Every tool in this toolkit resolves the authenticated calling thread into the
 * `McpServeOptions` the legacy CLI-driven implementation requires. The legacy
 * code remains the validation and execution authority; this layer only supplies
 * thread identity, workspace, runtime mode, and the delegated model default.
 */
const resolveServeOptions = Effect.fn("DelegationToolkit.resolveServeOptions")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const threadId = invocation.threadId;
  const projections = yield* ProjectionSnapshotQuery;
  const context = yield* projections
    .getThreadCheckpointContext(threadId)
    .pipe(
      Effect.mapError((cause) => toolError(`Could not resolve the calling chat: ${String(cause)}`)),
    );
  if (Option.isNone(context)) {
    return yield* toolError("The calling chat no longer exists.");
  }
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.mapError((cause) => toolError(`Could not read server settings: ${String(cause)}`)),
  );
  const directory = yield* ProviderSessionDirectory;
  const binding = yield* directory
    .getBinding(threadId)
    .pipe(Effect.mapError((cause) => toolError(`Could not read thread binding: ${String(cause)}`)));
  // `cwd` is the thread's own worktree, which is also what `t3-tools` hands the
  // legacy helpers. It comes from the thread's checkpoint binding rather than a
  // provider session directory, because a provider session's cwd is itself
  // derived from that binding (`resolveThreadWorkspaceCwd`) and can never be a
  // subdirectory of the thread's checkout. Delegation targets the thread, not
  // whichever provider happens to be driving it.
  const cwd = context.value.worktreePath ?? context.value.workspaceRoot;
  const cli = resolveMcpCliInvocation();
  const options: McpServeOptions = {
    cwd,
    // The legacy functions are invoked directly, so this set is not an
    // availability filter here. It only has to satisfy the contract shape.
    toolsets: new Set(["delegate_work"]),
    threadId,
    cliCommand: cli.cliCommand,
    ...(cli.cliArgsPrefix.length > 0 ? { cliArgsPrefix: cli.cliArgsPrefix } : {}),
    cliBaseDir: serverConfig.baseDir,
    runtimeMode:
      Option.isSome(binding) && binding.value.runtimeMode !== undefined
        ? binding.value.runtimeMode
        : "full-access",
    providerInstanceId: invocation.providerInstanceId,
    delegatedDefaultModelSelection: settings.delegatedThreadModelSelection,
  };
  return options;
});

type DelegationToolRequirements =
  | McpInvocationContext.McpInvocationContext
  | ProjectionSnapshotQuery
  | ProviderSessionDirectory
  | ServerConfig
  | ServerSettingsService;

/**
 * Runs a legacy tool implementation, converting any thrown error into the
 * toolkit's failure type so the MCP layer never leaks an unhandled rejection.
 * Every legacy tool returns CLI stdout as text.
 */
const runLegacyTool = (
  invoke: (options: McpServeOptions) => Promise<string>,
): Effect.Effect<string, DelegationToolError, DelegationToolRequirements> =>
  Effect.gen(function* () {
    const options = yield* resolveServeOptions();
    return yield* Effect.tryPromise({
      try: () => invoke(options),
      catch: (cause) => toolError(cause instanceof Error ? cause.message : String(cause)),
    });
  });

const asRecord = (input: unknown): Record<string, unknown> => input as Record<string, unknown>;

export const DelegationToolkitHandlersLive = DelegationToolkit.toLayer({
  delegate_work: (input) =>
    Effect.gen(function* () {
      const options = yield* resolveServeOptions();
      const record = asRecord(input);
      return yield* Effect.tryPromise({
        try: () =>
          withNestedThreadAudit(options, "delegate_work", randomUUID(), record, (attempts) =>
            delegateWorkTool(options, record, {}, attempts),
          ),
        catch: (cause) => toolError(cause instanceof Error ? cause.message : String(cause)),
      });
    }),

  send_to_thread: (input) => runLegacyTool((options) => sendToThreadTool(options, asRecord(input))),

  assign_to_thread: (input) =>
    runLegacyTool((options) => sendToThreadTool(options, asRecord(input), "assignment")),

  report_to_parent: (input) =>
    runLegacyTool((options) => reportToParentTool(options, asRecord(input))),

  set_child_wait: (input) =>
    runLegacyTool((options) =>
      setChildWaitTool(options, {
        ...asRecord(input),
        // Restore automatic follow-up when the caller supplied no condition.
        condition: input.condition ?? null,
      }),
    ),

  create_isolated_workspace: (input) =>
    runLegacyTool((options) => createIsolatedWorkspaceTool(options, asRecord(input))),

  switch_workspace: (input) =>
    runLegacyTool((options) => switchWorkspaceTool(options, asRecord(input))),

  associate_pull_request: (input) =>
    runLegacyTool((options) => associatePullRequestTool(options, asRecord(input))),

  link_pull_request: (input) =>
    runLegacyTool((options) => linkPullRequestTool(options, asRecord(input))),

  unlink_pull_request: (input) =>
    runLegacyTool((options) => unlinkPullRequestTool(options, asRecord(input))),

  list_thread_pull_requests: () => runLegacyTool((options) => listThreadPullRequestsTool(options)),
});
