import { randomUUID } from "node:crypto";

import { Effect, Option } from "effect";

import { ServerConfig } from "../../../config.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import {
  delegateWorkTool,
  withNestedThreadAudit,
  type McpServeOptions,
} from "../../../mcpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

import { DelegationToolkit, DelegationToolError } from "./tools.ts";

const toolError = (message: string) => new DelegationToolError({ message });

/**
 * Wraps the legacy CLI-driven delegation implementation for provider MCP
 * sessions. The legacy code remains the validation and execution authority;
 * this layer only resolves the authenticated calling thread into the
 * `McpServeOptions` it requires.
 */
export const DelegationToolkitHandlersLive = DelegationToolkit.toLayer({
  delegate_work: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const threadId = invocation.threadId;
      const projections = yield* ProjectionSnapshotQuery;
      const context = yield* projections
        .getThreadCheckpointContext(threadId)
        .pipe(
          Effect.mapError((cause) =>
            toolError(`Could not resolve the calling chat: ${String(cause)}`),
          ),
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
        .pipe(
          Effect.mapError((cause) => toolError(`Could not read thread binding: ${String(cause)}`)),
        );
      const entryPath = process.argv[1];
      const options: McpServeOptions = {
        cwd: context.value.worktreePath ?? context.value.workspaceRoot,
        toolsets: new Set(["delegate_work"]),
        threadId,
        cliCommand: entryPath !== undefined ? process.execPath : "t3",
        ...(entryPath !== undefined ? { cliArgsPrefix: [entryPath] } : {}),
        cliBaseDir: serverConfig.baseDir,
        runtimeMode:
          Option.isSome(binding) && binding.value.runtimeMode !== undefined
            ? binding.value.runtimeMode
            : "full-access",
        providerInstanceId: invocation.providerInstanceId,
        delegatedDefaultModelSelection: settings.delegatedThreadModelSelection,
      };
      const record = input as unknown as Record<string, unknown>;
      return yield* Effect.tryPromise({
        try: () =>
          withNestedThreadAudit(options, "delegate_work", randomUUID(), record, (attempts) =>
            delegateWorkTool(options, record, {}, attempts),
          ),
        catch: (cause) => toolError(cause instanceof Error ? cause.message : String(cause)),
      });
    }),
});
