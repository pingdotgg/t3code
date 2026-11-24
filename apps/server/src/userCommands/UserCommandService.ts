import {
  USER_COMMAND_DEFAULT_TIMEOUT_MS,
  UserCommandError,
  UserCommandsFile,
  type ProjectId,
  type ThreadId,
  type UserCommandsListResult,
  type UserCommandsRunInput,
  type UserCommandsRunResult,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  expandHome,
  resolveUserCommands,
  splitCommandArgs,
  type ResolvedUserCommand,
} from "./resolveUserCommands.ts";

/** Markdown lands in every client's thread stream, so it stays small. */
const MARKDOWN_MAX_BYTES = 128 * 1024;
/** A page is stored as an attachment, not sent in the stream; cutting one off would break it. */
const HTML_MAX_BYTES = 4 * 1024 * 1024;
const HTML_INITIAL_HEIGHT = 480;
const TRUNCATED_MARKER = "\n\n… output truncated";

const decodeCommandsFile = Schema.decodeEffect(fromLenientJson(UserCommandsFile));

export class UserCommandService extends Context.Service<
  UserCommandService,
  {
    /** The commands a project's threads offer: user-wide ones, overridden by the project's own. */
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<UserCommandsListResult, UserCommandError>;
    /**
     * Runs a command in the thread's folder, or the project's once a removed worktree has taken
     * the thread's away, and records its output as a thread item. Returns
     * once the item is written; the run is not tied to the caller, so it finishes if they leave.
     */
    readonly run: (
      input: UserCommandsRunInput,
    ) => Effect.Effect<UserCommandsRunResult, UserCommandError>;
  }
>()("t3/userCommands/UserCommandService") {}

const unavailable = (message: string) => (cause: unknown) =>
  new UserCommandError({ reason: "unavailable", message, cause });

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const htmlRender = yield* HtmlRender.HtmlRender;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const scope = yield* Effect.scope;
  const home = NodeOS.homedir();
  const warnedClashes = yield* Ref.make<ReadonlySet<string>>(new Set());

  const readUserCommands = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(config.userCommandsConfigPath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.undefined
            : Effect.logWarning("Could not read the user commands file.", {
                path: config.userCommandsConfigPath,
                cause: error,
              }).pipe(Effect.as(undefined)),
      }),
    );
    if (raw === undefined) return [];
    return yield* decodeCommandsFile(raw).pipe(
      Effect.map((file) => file.commands),
      Effect.catchTags({
        SchemaError: (error) =>
          Effect.logWarning("Ignoring an invalid user commands file.", {
            path: config.userCommandsConfigPath,
            cause: error,
          }).pipe(Effect.as([])),
      }),
    );
  });

  const warnAboutClashes = (
    ignored: ReadonlyArray<{ readonly name: string; readonly source: string }>,
  ) =>
    Effect.forEach(
      ignored,
      ({ name, source }) =>
        Ref.modify(warnedClashes, (seen) => {
          const key = `${source}:${name}`;
          return seen.has(key)
            ? ([false, seen] as const)
            : ([true, new Set(seen).add(key)] as const);
        }).pipe(
          Effect.flatMap((first) =>
            first
              ? Effect.logWarning(
                  `Ignoring the ${source} command /${name}: it is a built-in command.`,
                )
              : Effect.void,
          ),
        ),
      { discard: true },
    );

  const commandsForProject = Effect.fn("UserCommandService.commandsForProject")(function* (
    projectId: ProjectId,
  ) {
    const user = yield* readUserCommands;
    const found = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(unavailable("Could not read the project.")));
    const file = Option.isNone(found)
      ? Option.none()
      : yield* projectFiles.load(found.value.workspaceRoot);
    const project = Option.match(file, { onNone: () => [], onSome: (f) => f.commands ?? [] });
    const resolved = resolveUserCommands({ user, project });
    yield* warnAboutClashes(resolved.ignored);
    return resolved.commands;
  });

  const list: UserCommandService["Service"]["list"] = Effect.fn("UserCommandService.list")(
    function* (projectId) {
      const commands = yield* commandsForProject(projectId);
      return {
        commands: commands.map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
          output: command.output,
          source: command.source,
        })),
      };
    },
  );

  const execute = Effect.fn("UserCommandService.execute")(function* (input: {
    readonly threadId: ThreadId;
    readonly command: ResolvedUserCommand;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
  }) {
    const { command } = input;
    const [program, ...rest] = command.run.map((argument) => expandHome(argument, home, path.join));
    const timeoutMs = command.timeoutMs ?? USER_COMMAND_DEFAULT_TIMEOUT_MS;
    const outcome = yield* runner
      .run({
        command: program ?? "",
        args: [...rest, ...input.args],
        cwd: input.cwd,
        timeout: timeoutMs,
        timeoutBehavior: "timedOutResult",
        ...(command.output === "html"
          ? { maxOutputBytes: HTML_MAX_BYTES, outputMode: "error" as const }
          : {
              maxOutputBytes: MARKDOWN_MAX_BYTES,
              outputMode: "truncate" as const,
              truncatedMarker: TRUNCATED_MARKER,
            }),
      })
      .pipe(Effect.result);
    if (outcome._tag === "Failure") {
      return { status: "failed" as const, error: outcome.failure.message };
    }
    const result = outcome.success;
    const stdout = result.stdout.trim().length === 0 ? undefined : result.stdout;
    if (result.timedOut) {
      return {
        status: "failed" as const,
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s.`,
      };
    }
    if (result.code !== 0) {
      return {
        status: "failed" as const,
        error: result.stderr.trim() || `Exited with code ${result.code}.`,
        ...(command.output === "markdown" && stdout !== undefined ? { markdown: stdout } : {}),
      };
    }
    if (command.output === "markdown") {
      return {
        status: "completed" as const,
        ...(stdout === undefined ? {} : { markdown: stdout }),
      };
    }
    if (stdout === undefined) return { status: "completed" as const };
    const published = yield* htmlRender
      .publish({
        html: stdout,
        threadId: input.threadId,
        title: `/${command.name}`,
        height: HTML_INITIAL_HEIGHT,
      })
      .pipe(Effect.result);
    return published._tag === "Success"
      ? { status: "completed" as const, htmlRender: published.success }
      : { status: "failed" as const, error: published.failure.message };
  });

  const run: UserCommandService["Service"]["run"] = Effect.fn("UserCommandService.run")(
    function* (input) {
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(unavailable("Could not read the thread.")));
      if (shell === null) {
        return yield* new UserCommandError({
          reason: "thread-not-found",
          message: "That thread no longer exists.",
        });
      }
      const command = (yield* commandsForProject(shell.projectId)).find(
        (candidate) => candidate.name === input.name,
      );
      if (command === undefined) {
        return yield* new UserCommandError({
          reason: "unknown-command",
          message: `There is no /${input.name} command in this project.`,
        });
      }
      const worktree =
        shell.worktreePath !== null &&
        (yield* fileSystem.exists(shell.worktreePath).pipe(Effect.orElseSucceed(() => false)))
          ? shell.worktreePath
          : undefined;
      const cwd =
        worktree ??
        (yield* projects
          .getById(shell.projectId)
          .pipe(Effect.mapError(unavailable("Could not read the project.")))).pipe(
          Option.map((project) => project.workspaceRoot),
          Option.getOrUndefined,
        );
      if (cwd === undefined) {
        return yield* new UserCommandError({
          reason: "unavailable",
          message: "The thread's project is gone.",
        });
      }
      const args = splitCommandArgs(input.args);
      const itemId = yield* ids.allocate
        .userCommandTurnItem({ threadId: input.threadId })
        .pipe(Effect.mapError(unavailable("Could not allocate an item.")));
      const startedAt = yield* DateTime.now;

      const finish = Effect.gen(function* () {
        const outcome = yield* execute({ threadId: input.threadId, command, args, cwd });
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId: input.threadId }),
              type: "turn-item.updated",
              threadId: input.threadId,
              ...(shell.latestRunId === null ? {} : { runId: shell.latestRunId }),
              occurredAt: now,
              payload: {
                id: itemId,
                threadId: input.threadId,
                runId: shell.latestRunId,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                // EventSink allocates the real position, after the run's existing items.
                ordinal: 0,
                status: outcome.status,
                // Args stay out of the title, which agents read in a thread's timeline.
                title: `/${command.name}`,
                startedAt,
                completedAt: now,
                updatedAt: now,
                type: "user_command",
                command: command.name,
                args: input.args.trim(),
                format: command.output,
                ...("markdown" in outcome ? { markdown: outcome.markdown } : {}),
                ...("htmlRender" in outcome ? { htmlRender: outcome.htmlRender } : {}),
                ...("error" in outcome ? { error: outcome.error } : {}),
              },
            },
          ],
        });
      }).pipe(Effect.mapError(unavailable("Could not record the command's output.")));

      // Forked into the service scope so a client that disconnects does not drop the result.
      const fiber = yield* Effect.forkIn(finish, scope);
      yield* Fiber.join(fiber);
      return { itemId };
    },
  );

  return UserCommandService.of({ list, run });
});

export const layer = Layer.effect(UserCommandService, make);
