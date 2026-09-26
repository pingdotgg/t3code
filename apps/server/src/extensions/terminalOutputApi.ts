import { AuthTerminalOperateScope, ExtensionOperationError } from "@t3tools/contracts";
import { TERMINAL_OUTPUT_API } from "@t3tools/extension-sdk/catalogue";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const readSnapshotInput = Schema.decodeUnknownSync(
  Schema.Struct({
    terminalId: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)),
  }),
  { onExcessProperty: "error" },
);
const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "terminal.output", detail });

export function createTerminalOutputApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly terminal: Pick<TerminalManager["Service"], "readOutput">;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const invoke = Effect.fn("TerminalOutputApi.invoke")(function* (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    principal: { readonly environmentId: string; readonly scopes: readonly string[] } | undefined,
  ) {
    signal.throwIfAborted();
    if (method !== "readSnapshot")
      return yield* failure("Terminal output API method is unavailable.");
    if (
      !principal ||
      principal.environmentId !== dependencies.environmentId ||
      !principal.scopes.includes(AuthTerminalOperateScope)
    )
      return yield* failure("Terminal authority is unavailable.");
    if (!context.resource.threadId)
      return yield* failure("Terminal output API requires a thread scope.");
    const safe = yield* Effect.try({
      try: () => readSnapshotInput(input),
      catch: () => failure("Invalid terminal output request."),
    });
    const scope = yield* resolve(context);
    const output = yield* dependencies.terminal
      .readOutput({
        threadId: context.resource.threadId,
        terminalId: safe.terminalId,
      })
      .pipe(Effect.catchCause(() => failure("Terminal output cannot be inspected.")));
    signal.throwIfAborted();
    const result =
      output === null
        ? null
        : output.threadId !== context.resource.threadId ||
            output.terminalId !== safe.terminalId ||
            output.cwd !== scope.cwd ||
            output.worktreePath !== scope.worktreePath
          ? yield* failure("Terminal output is unavailable in the requested workspace.")
          : output.retainedByteLength < 0 ||
              !Number.isSafeInteger(output.retainedByteLength) ||
              Buffer.byteLength(output.contents) > 8_192 ||
              output.retainedByteLength < Buffer.byteLength(output.contents) ||
              output.truncated !== Buffer.byteLength(output.contents) < output.retainedByteLength ||
              output.contents.length > 8_192
            ? yield* failure("Terminal output exceeds the public bounds.")
            : {
                terminalId: output.terminalId,
                contents: output.contents,
                retainedByteLength: output.retainedByteLength,
                truncated: output.truncated,
              };
    yield* resolve(scope.context);
    signal.throwIfAborted();
    return result;
  });
  return {
    providerId: "t3.host-terminal-output",
    definition: TERMINAL_OUTPUT_API,
    requiresRootAuthority: true,
    invoke: (method, input, context, signal, metadata) =>
      Effect.runPromise(invoke(method, input, context, signal, metadata.principal), { signal }),
  };
}

export const makeTerminalOutputApiProvider = Effect.fn("TerminalOutputApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createTerminalOutputApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    terminal: yield* TerminalManager,
  });
});
