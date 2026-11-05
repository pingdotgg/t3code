import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergeRestartCancelledBackgroundWork } from "./RestartBackgroundNote.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { createTerminalSpawnEnv } from "../terminal/Manager.ts";
import { defaultShellResolver, resolveShellCandidates } from "../terminal/shell.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const SHELL_FOREGROUND_TIMEOUT_MS = 120_000;
type CommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
type ShellItem = CommandItem & { userShell: NonNullable<CommandItem["userShell"]> };

function isUserShellItem(item: OrchestrationV2TurnItem | null): item is ShellItem {
  return item?.type === "command_execution" && item.userShell !== undefined;
}

export function shellCommandContext(item: ShellItem): string {
  const shell = item.userShell;
  let result: string;
  if (item.status === "running") {
    result = `Still running in the background (did not finish within 120s). Output file: ${shell.outputFile ?? "unavailable"}`;
  } else {
    let stopped = "";
    if (shell.stoppedByUser) stopped = "Stopped by the user.\n";
    else if (item.status === "cancelled" || item.status === "interrupted")
      stopped = "Stopped before completion.\n";

    let output = item.output ?? "";
    if (shell.outputTruncated || (item.output === undefined && shell.outputFile !== undefined)) {
      output = `Output file: ${shell.outputFile ?? "unavailable"}\n${
        shell.outputTruncated && item.exitCode !== 0 ? output : output.slice(0, 2000)
      }`;
    }
    const duration = (shell.durationSeconds ?? 0).toFixed(4);
    result = `${stopped}Exit code: ${item.exitCode ?? "unknown"}\nDuration: ${duration} seconds\nOutput:\n${output}`;
  }
  return `The user ran this shell command directly, not through you. Do not re-run it.\n<user_shell_command>\n<command>\n${item.input}\n</command>\n<result>\nCwd: ${shell.cwd}\n${result}\n</result>\n</user_shell_command>`;
}

export class ShellCommandError extends Schema.TaggedError<ShellCommandError>()(
  "ShellCommandError",
  {
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Shell command failed.";
  }
}

export class ShellCommandService extends Context.Service<
  ShellCommandService,
  {
    readonly execute: (input: {
      readonly item: ShellItem;
      readonly run: OrchestrationV2Run;
      readonly driver: ProviderDriverKind;
    }) => Effect.Effect<ShellItem, ShellCommandError>;
    readonly stop: (
      threadId: ThreadId,
      itemId: TurnItemId,
    ) => Effect.Effect<void, ShellCommandError>;
    readonly cleanup: (threadId: ThreadId) => Effect.Effect<void, ShellCommandError>;
    readonly pending: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ShellItem>, ShellCommandError>;
    readonly delivered: (items: ReadonlyArray<ShellItem>) => Effect.Effect<void, ShellCommandError>;
  }
>()("t3/orchestration-v2/ShellCommandService") {}

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const processPlatform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const hub = yield* CommandOutputHub.CommandOutputHub;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const continuations = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const live = new Map<
    TurnItemId,
    { threadId: ThreadId; fiber: Fiber.Fiber<void, ShellCommandError>; stop: () => void }
  >();
  const directory = (threadId: ThreadId) =>
    path.join(
      config.attachmentsDir,
      "shell-output",
      encodeURIComponent(threadId).replaceAll(".", "%2E"),
    );
  const event = Effect.fn("ShellCommandService.event")(function* (
    item: ShellItem,
  ): Effect.fn.Return<OrchestrationV2DomainEvent, IdAllocator.IdAllocatorV2AllocationError> {
    return {
      id: yield* ids.allocate.event({ threadId: item.threadId }),
      type: "turn-item.updated",
      threadId: item.threadId,
      runId: item.runId ?? undefined,
      nodeId: item.nodeId ?? undefined,
      occurredAt: item.updatedAt,
      payload: item,
    };
  });
  const persist = Effect.fn("ShellCommandService.persist")(function* (item: ShellItem) {
    yield* sink.write({ events: [yield* event(item)] });
  });
  const execute = Effect.fn("ShellCommandService.execute")(
    function* (input: {
      readonly item: ShellItem;
      readonly run: OrchestrationV2Run;
      readonly driver: ProviderDriverKind;
    }) {
      const { item: initial, run } = input;
      const target = { threadId: initial.threadId, itemId: initial.id };
      const outputFile = path.join(
        directory(initial.threadId),
        `${encodeURIComponent(initial.id)}.log`,
      );
      let item: ShellItem = { ...initial, userShell: { ...initial.userShell, outputFile } };
      const claimed = yield* commands.withLock(
        initial.threadId,
        Effect.gen(function* () {
          const existing = yield* projections.getTurnItem(target);
          if (isUserShellItem(existing)) {
            item = existing;
            return false;
          }
          if (run.activeAttemptId === null) {
            item = { ...item, status: "interrupted" };
            return false;
          }
          const written = yield* sink.writeIfRunCurrent({
            threadId: item.threadId,
            runId: run.id,
            activeAttemptId: run.activeAttemptId,
            expectedStatus: "starting",
            events: [yield* event(item)],
          });
          if (!written.committed) item = { ...item, status: "interrupted" };
          return written.committed;
        }),
      );
      if (!claimed) return item;
      let stoppedByUser = false;
      let backgrounded = false;
      let head = "";
      let tail = "";
      let total = 0;
      let exitCode: number | undefined;
      const started = yield* DateTime.now;
      const execution = Effect.gen(function* () {
        yield* fs.makeDirectory(directory(item.threadId), { recursive: true });
        const outputHandle = yield* fs.open(outputFile, { flag: "w" });
        const encoder = new TextEncoder();
        const candidates = resolveShellCandidates(
          () => defaultShellResolver(processPlatform, environment),
          processPlatform,
          environment,
        );
        const child = yield* Effect.firstSuccessOf(
          candidates.map(({ shell }) =>
            spawner.spawn(
              ChildProcess.make(
                shell,
                processPlatform === "win32"
                  ? /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)
                    ? ["/d", "/s", "/c", item.input]
                    : ["-NoLogo", "-NonInteractive", "-Command", item.input]
                  : ["-lc", item.input],
                {
                  cwd: item.userShell.cwd,
                  env: createTerminalSpawnEnv(environment, null, processPlatform, home),
                  stdin: "ignore",
                  forceKillAfter: "2 seconds",
                },
              ),
            ),
          ),
        );
        yield* Stream.merge(
          child.stdout.pipe(Stream.decodeText()),
          child.stderr.pipe(Stream.decodeText()),
        ).pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              total += chunk.length;
              head = (head + chunk).slice(0, 30_000);
              tail = (tail + chunk).slice(-5000);
              yield* outputHandle.writeAll(encoder.encode(chunk));
              yield* hub.append({ ...target, chunk });
            }),
          ),
        );
        exitCode = Number(yield* child.exitCode);
      });
      const finish = Effect.fn("ShellCommandService.finish")(function* () {
        const now = yield* DateTime.now;
        const latest = yield* projections.getTurnItem(target);
        const failed = exitCode !== 0;
        const cap = failed ? 10_000 : 30_000;
        const output =
          total <= cap ? head : failed ? `${head.slice(0, 5000)}\n…\n${tail}` : head.slice(0, 2000);
        const retained = backgrounded || total > cap;
        const { outputFile: _file, ...shell } = item.userShell;
        let delivery = isUserShellItem(latest) ? latest.userShell.delivery : ("pending" as const);
        if (backgrounded && delivery !== "dismissed") delivery = "pending";
        item = {
          ...item,
          status: exitCode === undefined ? "interrupted" : failed ? "failed" : "completed",
          exitCode,
          output,
          userShell: {
            ...shell,
            delivery,
            stoppedByUser,
            backgrounded,
            outputTruncated: total > cap,
            ...(retained ? { outputFile } : {}),
            durationSeconds: (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(started)) / 1000,
          },
          completedAt: now,
          updatedAt: now,
        };
        yield* persist(item);
        if (backgrounded && exitCode === undefined && !stoppedByUser) {
          const { runs } = yield* projections.getThreadRecords(item.threadId, ["runs"], {
            runIds: [run.id],
          });
          yield* sink.write({
            events: [
              {
                id: yield* ids.allocate.event({ threadId: item.threadId }),
                type: "run.background-work-cancelled",
                threadId: item.threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  runId: run.id,
                  restartCancelledBackgroundWork: mergeRestartCancelledBackgroundWork(
                    runs[0]?.restartCancelledBackgroundWork ?? [],
                    [
                      {
                        kind: "shell",
                        label: item.input.slice(0, 160),
                        id: item.id,
                        ...((yield* settings.getSettings).respondToShellCommands
                          ? { awaited: true as const }
                          : {}),
                      },
                    ],
                  ),
                },
              },
            ],
          });
        }
        yield* hub.finish(target);
        if (!retained) yield* fs.remove(outputFile, { force: true });
        live.delete(item.id);
        if (
          backgrounded &&
          (exitCode !== undefined || stoppedByUser) &&
          (yield* settings.getSettings).respondToShellCommands &&
          item.providerThreadId !== null
        ) {
          yield* continuations.offer({
            threadId: item.threadId,
            providerThreadId: item.providerThreadId,
            driver: input.driver,
            detail: "No human input occurred. A user-run background shell command finished.",
            delivery: "message_text",
            messageId: MessageId.make(`shell-completion:${item.id}`),
          });
        }
      });
      const fiber = yield* execution.pipe(
        Effect.scoped,
        Effect.ensuring(commands.withLock(item.threadId, finish()).pipe(Effect.orDie)),
        Effect.mapError((cause) => new ShellCommandError({ threadId: item.threadId, cause })),
        Effect.interruptible,
        Effect.forkIn(scope),
      );
      live.set(item.id, {
        threadId: item.threadId,
        fiber,
        stop: () => {
          stoppedByUser = true;
        },
      });
      yield* Fiber.join(fiber).pipe(
        Effect.timeoutOrElse({
          duration: SHELL_FOREGROUND_TIMEOUT_MS,
          orElse: () =>
            Effect.sync(() => {
              backgrounded = true;
            }),
        }),
        Effect.interruptible,
        Effect.onInterrupt(() => {
          stoppedByUser = true;
          return Fiber.interrupt(fiber);
        }),
      );
      if (backgrounded) {
        yield* commands.withLock(
          item.threadId,
          Effect.gen(function* () {
            const latest = yield* projections.getTurnItem(target);
            if (!isUserShellItem(latest)) return;
            item = {
              ...latest,
              userShell: { ...latest.userShell, backgrounded: true },
              updatedAt: yield* DateTime.now,
            };
            yield* persist(item);
          }),
        );
      }
      return item;
    },
    Effect.uninterruptible,
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) => new ShellCommandError({ threadId: input.item.threadId, cause })),
      ),
  );
  const stop = Effect.fn("ShellCommandService.stop")(function* (
    threadId: ThreadId,
    itemId: TurnItemId,
  ) {
    const active = live.get(itemId);
    if (active?.threadId !== threadId) return;
    active.stop();
    yield* Fiber.interrupt(active.fiber);
  });
  const cleanup = Effect.fn("ShellCommandService.cleanup")(
    function* (threadId: ThreadId) {
      yield* Effect.forEach(
        [...live.entries()].filter(([, entry]) => entry.threadId === threadId),
        ([itemId]) => stop(threadId, itemId),
        { discard: true },
      );
      yield* fs.remove(directory(threadId), { recursive: true, force: true });
    },
    (effect, threadId) =>
      effect.pipe(Effect.mapError((cause) => new ShellCommandError({ threadId, cause }))),
  );
  const pending = Effect.fn("ShellCommandService.pending")(
    function* (threadId: ThreadId) {
      const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["command_execution"],
        pendingUserShellCommands: true,
      });
      const items = turnItems.filter(
        (item): item is ShellItem => isUserShellItem(item) && item.userShell.delivery === "pending",
      );
      // Archiving removes output files but keeps pending results, so drop paths that are gone.
      return yield* Effect.forEach(items, (item) => {
        const { outputFile, ...userShell } = item.userShell;
        if (outputFile === undefined) return Effect.succeed(item);
        return fs
          .exists(outputFile)
          .pipe(Effect.map((exists): ShellItem => (exists ? item : { ...item, userShell })));
      });
    },
    (effect, threadId) =>
      effect.pipe(Effect.mapError((cause) => new ShellCommandError({ threadId, cause }))),
  );
  const delivered = Effect.fn("ShellCommandService.delivered")(
    function* (items: ReadonlyArray<ShellItem>) {
      for (const item of items) {
        yield* commands.withLock(
          item.threadId,
          Effect.gen(function* () {
            const latest = yield* projections.getTurnItem({
              threadId: item.threadId,
              itemId: item.id,
            });
            if (
              isUserShellItem(latest) &&
              latest.userShell.delivery === "pending" &&
              latest.status === item.status &&
              latest.output === item.output &&
              DateTime.toEpochMillis(latest.updatedAt) === DateTime.toEpochMillis(item.updatedAt)
            ) {
              yield* persist({
                ...latest,
                userShell: { ...latest.userShell, delivery: "delivered" },
                updatedAt: yield* DateTime.now,
              });
            }
          }),
        );
      }
    },
    (effect, items) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new ShellCommandError({ threadId: items[0]?.threadId ?? "", cause }),
        ),
      ),
  );
  return ShellCommandService.of({ execute, stop, cleanup, pending, delivered });
});
export const layer = Layer.effect(ShellCommandService, make);
