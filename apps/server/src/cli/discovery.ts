import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadListResult,
  ModelSelection,
  ProjectId,
  type AuthMcpClientAccess,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/cli";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession, type McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { expandHomePath } from "../os-jank.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { resolveCliAuthConfig } from "./config.ts";

class ThreadServerNotRunningError extends Schema.TaggedError<ThreadServerNotRunningError>()(
  "ThreadServerNotRunningError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No running T3 Code server uses ${this.baseDir}. Start T3 Code, then retry.`;
  }
}

class ThreadServerUnreachableError extends Schema.TaggedError<ThreadServerUnreachableError>()(
  "ThreadServerUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    const reason = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Could not reach the T3 Code server at ${this.origin}.${reason}`;
  }
}

class ThreadToolFailedError extends Schema.TaggedError<ThreadToolFailedError>()(
  "ThreadToolFailedError",
  { tool: Schema.String, detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

class DiscoveryProjectNotFoundError extends Schema.TaggedError<DiscoveryProjectNotFoundError>()(
  "DiscoveryProjectNotFoundError",
  { identifier: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `No T3 Code project matches '${this.identifier}'. Pass a project id or a path inside a project.`;
  }
}

export const DiscoveryCliError = Schema.Union([
  ThreadServerNotRunningError,
  ThreadServerUnreachableError,
  ThreadToolFailedError,
  DiscoveryProjectNotFoundError,
]);
const isDiscoveryCliError = Schema.is(DiscoveryCliError);
export const reportDiscoveryErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isDiscoveryCliError(error) ? Console.error(error.message) : Effect.void,
    ),
  );

const decodeFailureText = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestratorMcpFailure));
const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});

const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);

const ProjectListResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      id: ProjectId,
      title: Schema.String,
      workspaceRoot: Schema.String,
      defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
        Schema.withDecodingDefault(Effect.succeed(null)),
      ),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.Int),
});

const toolFailureDetail = (result: typeof ToolResult.Type) => {
  const text = result.content?.find((part) => part.text !== undefined)?.text ?? "";
  return Option.match(decodeFailureText(text), {
    onNone: () => text || "The tool call failed.",
    onSome: (failure) => failure.message,
  });
};

const makeThreadTools = (session: McpToolSession, origin: string) => {
  const unexpected = (tool: string) =>
    new ThreadToolFailedError({
      tool,
      detail: `The server sent an unexpected ${tool} result. Update the t3 CLI to match the server.`,
    });
  return {
    call: Effect.fn("cli.thread.callTool")(function* <S extends Schema.Decoder<unknown>>(
      tool: string,
      args: Readonly<Record<string, unknown>>,
      schema: S,
    ): Effect.fn.Return<S["Type"], ThreadServerUnreachableError | ThreadToolFailedError> {
      const raw = yield* session
        .call(tool, args)
        .pipe(Effect.mapError((cause) => new ThreadServerUnreachableError({ origin, cause })));
      const result = yield* decodeToolResult(raw).pipe(Effect.mapError(() => unexpected(tool)));
      if (result.isError === true) {
        return yield* new ThreadToolFailedError({ tool, detail: toolFailureDetail(result) });
      }
      return yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
        Effect.mapError(() => unexpected(tool)),
      );
    }),
  };
};
export type ThreadTools = ReturnType<typeof makeThreadTools>;

/**
 * Signs in as a short-lived MCP client of the running server, the same way an
 * outside agent does, and revokes that session when the command ends.
 */
export const withThreadTools = Effect.fn("cli.thread.withThreadTools")(function* <A, E, R>(
  flags: { readonly baseDir: Option.Option<string> },
  run: (tools: ThreadTools) => Effect.Effect<A, E, R>,
  options?: { readonly access?: AuthMcpClientAccess; readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, {
    quietLogs: options?.quietLogs === true,
  });
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new ThreadServerNotRunningError({ baseDir: config.baseDir });
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueMcpClientSession({
        label: "t3 thread cli",
        // The CLI runs as the machine's owner. New threads still start at
        // the project's default mode, never at this ceiling by default.
        access: options?.access ?? "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const session = yield* mcpToolSession({
      endpoint: new URL("/mcp", origin).href,
      authorization: `Bearer ${issued.token}`,
      clientName: "t3-thread-cli",
    }).pipe(Effect.mapError((cause) => new ThreadServerUnreachableError({ origin, cause })));
    return yield* run(makeThreadTools(session, origin));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provideMerge(ServerConfig.layer(config)),
        Layer.provide(
          Layer.succeed(
            References.MinimumLogLevel,
            options?.quietLogs === true ? "Error" : config.logLevel,
          ),
        ),
      ),
    ),
  );
});

export const resolveDiscoveryProject = Effect.fn("cli.discovery.resolveProject")(function* <
  P extends {
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  },
>(projects: ReadonlyArray<P>, identifier: string) {
  const byId = projects.find((project) => project.id === identifier);
  if (byId !== undefined) return byId;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  // Stored roots keep the path the project was added with, which may pass
  // through a symlink (macOS /tmp), so both sides compare as real paths.
  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  const target = yield* realPath(
    path.resolve(yield* HostProcess.WorkingDirectory, yield* expandHomePath(identifier)),
  );
  const roots = yield* Effect.forEach(projects, (project) =>
    Effect.map(realPath(project.workspaceRoot), (root) => ({ project, root })),
  );
  const containing = roots
    .filter(({ root }) => {
      const relative = path.relative(root, target);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    })
    .toSorted((left, right) => right.root.length - left.root.length)[0];
  if (containing === undefined) {
    return yield* new DiscoveryProjectNotFoundError({ identifier });
  }
  return containing.project;
});

export const listAllProjects = Effect.fn("cli.thread.listAllProjects")(function* (
  tools: ThreadTools,
) {
  const projects: Array<(typeof ProjectListResult.Type)["projects"][number]> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: typeof ProjectListResult.Type = yield* tools.call(
      "t3_project_list",
      { cursor, limit: 100 },
      ProjectListResult,
    );
    projects.push(...page.projects);
    cursor = page.nextCursor;
  }
  return projects;
});

export const listAllThreads = Effect.fn("cli.discovery.listAllThreads")(function* (
  tools: ThreadTools,
  input: Pick<OrchestratorMcpThreadListInput, "projectId" | "allProjects" | "statuses">,
) {
  const threads: Array<OrchestratorMcpThreadListItem> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: OrchestratorMcpThreadListResult = yield* tools.call(
      "t3_thread_list",
      { ...input, includeSubagents: false, limit: 100, cursor },
      OrchestratorMcpThreadListResult,
    );
    threads.push(...page.threads);
    cursor = page.nextCursor;
  }
  return threads;
});
