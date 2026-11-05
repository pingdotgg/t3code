import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

/** Paths in one `git check-ignore` call, which bounds its stdin and stdout. */
export const IGNORE_CHECK_CHUNK_SIZE = 1000;

/** Ignore checks of one workspace running at once; checks beyond this wait and share a call. */
export const IGNORE_CHECKS_PER_WORKSPACE = 4;

export interface IgnoreCheckOutput {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface IgnoreCheckRequest {
  readonly workspace: string;
  readonly gitCwd: string;
  readonly paths: ReadonlyArray<string>;
  /** False when Git's answer can't be split per folder, as for paths beyond a symlink. */
  readonly shareable: boolean;
}

interface Call {
  waiting: number;
  fiber: Fiber.Fiber<void> | undefined;
}

interface Check {
  readonly gitCwd: string;
  readonly paths: ReadonlyArray<string>;
  readonly key: string;
  readonly done: Deferred.Deferred<IgnoreCheckOutput | undefined>;
  shareable: boolean;
  abandoned: boolean;
  call: Call | undefined;
}

interface Workspace {
  running: number;
  queued: Array<Check>;
}

/**
 * Runs `git check-ignore -z --stdin` for listings, at most four calls per workspace. Checks that
 * arrive while four run wait, and the next call answers all of them for one Git root; identical
 * unshareable checks share one call. Nothing is reused: a call starts after all its checks arrived.
 */
export const makeIgnoreCheckQueue = <E>(
  run: (
    gitCwd: string,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<IgnoreCheckOutput & { readonly stdoutTruncated: boolean }, E>,
) =>
  Effect.map(Effect.scope, (scope) => {
    const workspaces = new Map<string, Workspace>();

    const answer = Effect.fn("WorkspaceEntries.answerIgnoreChecks")(function* (
      workspace: Workspace,
      checks: Array<Check>,
    ) {
      const shared = checks.length > 1 && checks[0]!.shareable;
      const result = yield* run(
        checks[0]!.gitCwd,
        shared ? checks.flatMap((check) => check.paths) : checks[0]!.paths,
      ).pipe(Effect.result);
      if (!shared) {
        const output = result._tag === "Success" ? result.success : undefined;
        for (const check of checks) yield* Deferred.succeed(check.done, output);
        return;
      }
      if (
        result._tag === "Success" &&
        (result.success.exitCode === 0 || result.success.exitCode === 1) &&
        !result.success.stdoutTruncated
      ) {
        // Git echoes each ignored path as it was given, so each folder takes back its own.
        const ignored = new Set(result.success.stdout.split("\0"));
        for (const check of checks) {
          const own = check.paths.filter((checkPath) => ignored.has(checkPath));
          yield* Deferred.succeed(check.done, {
            exitCode: own.length > 0 ? 0 : 1,
            stdout: own.map((ignoredPath) => `${ignoredPath}\0`).join(""),
          });
        }
        return;
      }
      // One path Git refuses (inside a submodule, outside the repository) fails the whole call,
      // and a timeout may be the batch's fault. Each folder is asked again alone, within the limit.
      const retries = checks.filter((check) => !check.abandoned);
      for (const check of retries) {
        check.call = undefined;
        check.shareable = false;
      }
      workspace.queued.unshift(...retries);
    });

    const release = (key: string, workspace: Workspace) =>
      Effect.suspend(() => {
        workspace.running -= 1;
        if (workspace.running === 0 && workspace.queued.length === 0) workspaces.delete(key);
        return start(key, workspace);
      });

    const start = (key: string, workspace: Workspace): Effect.Effect<void> =>
      Effect.suspend(() => {
        const calls: Array<Array<Check>> = [];
        while (workspace.running < IGNORE_CHECKS_PER_WORKSPACE && workspace.queued.length > 0) {
          const head = workspace.queued[0]!;
          const checks: Array<Check> = [];
          let pathCount = 0;
          workspace.queued = workspace.queued.filter((check) => {
            const joins = head.shareable
              ? check.shareable &&
                check.gitCwd === head.gitCwd &&
                (checks.length === 0 || pathCount + check.paths.length <= IGNORE_CHECK_CHUNK_SIZE)
              : !check.shareable && check.key === head.key;
            if (!joins) return true;
            checks.push(check);
            pathCount += check.paths.length;
            return false;
          });
          workspace.running += 1;
          calls.push(checks);
        }
        return Effect.forEach(
          calls,
          (checks) => {
            const call: Call = { waiting: checks.length, fiber: undefined };
            for (const check of checks) check.call = call;
            const finish = (exit: Exit.Exit<void>) => {
              const outcome = Exit.isSuccess(exit)
                ? Exit.succeed(undefined)
                : Exit.failCause(exit.cause);
              return Effect.forEach(
                checks,
                (check) => (check.call === call ? Deferred.done(check.done, outcome) : Effect.void),
                { discard: true },
              ).pipe(Effect.andThen(release(key, workspace)));
            };
            let started = false;
            // Started at once, so the finalizer is in place before anything can interrupt the call.
            return Effect.suspend(() => {
              started = true;
              return answer(workspace, checks);
            }).pipe(
              Effect.onExit(finish),
              Effect.forkIn(scope, { startImmediately: true }),
              Effect.flatMap((fiber) => {
                call.fiber = fiber;
                // A closed scope returns a fiber that never ran, so its finalizer never will.
                return started
                  ? Effect.void
                  : Effect.exit(Fiber.join(fiber)).pipe(Effect.flatMap(finish));
              }),
            );
          },
          { discard: true },
        );
      });

    const abandon = (workspace: Workspace, check: Check) =>
      Effect.suspend(() => {
        check.abandoned = true;
        const call = check.call;
        if (call === undefined) {
          workspace.queued = workspace.queued.filter((queued) => queued !== check);
          return Effect.void;
        }
        call.waiting -= 1;
        // Stop Git once no listing waits for its answer.
        return call.waiting === 0 && call.fiber !== undefined
          ? Fiber.interrupt(call.fiber)
          : Effect.void;
      });

    return (request: IgnoreCheckRequest): Effect.Effect<IgnoreCheckOutput | undefined> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          let workspace = workspaces.get(request.workspace);
          if (workspace === undefined) {
            workspace = { running: 0, queued: [] };
            workspaces.set(request.workspace, workspace);
          }
          // A free slot means nothing waits, so this call has no one to share with: it runs here,
          // and interrupting this listing stops its Git process.
          if (workspace.running < IGNORE_CHECKS_PER_WORKSPACE) {
            workspace.running += 1;
            return restore(
              run(request.gitCwd, request.paths).pipe(Effect.orElseSucceed(() => undefined)),
            ).pipe(Effect.ensuring(release(request.workspace, workspace)));
          }
          const check: Check = {
            gitCwd: request.gitCwd,
            paths: request.paths,
            key: `${request.gitCwd}\0${request.paths.join("\0")}`,
            done: Deferred.makeUnsafe<IgnoreCheckOutput | undefined>(),
            shareable: request.shareable,
            abandoned: false,
            call: undefined,
          };
          workspace.queued.push(check);
          const own = workspace;
          return start(request.workspace, workspace).pipe(
            Effect.andThen(
              restore(Deferred.await(check.done)).pipe(
                Effect.onInterrupt(() => abandon(own, check)),
              ),
            ),
          );
        }),
      );
  });
