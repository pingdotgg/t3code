// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export const ACP_PROCESS_TERMINATE_GRACE = "250 millis" as const satisfies Duration.Input;

const realSleep = (duration: Duration.Input): Effect.Effect<void> =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        // @effect-diagnostics-next-line globalTimers:off
        setTimeout(resolve, Duration.toMillis(duration));
      }),
  );

function readProcessRows(): ReadonlyArray<{ readonly pid: number; readonly ppid: number }> {
  try {
    const raw = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 1024 * 1024,
    });
    return raw.split(/\r?\n/g).flatMap((line) => {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      return Number.isInteger(pid) && Number.isInteger(ppid) ? [{ pid, ppid }] : [];
    });
  } catch {
    return [];
  }
}

function collectDescendantPids(rootPid: number): ReadonlyArray<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of readProcessRows()) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }

  const descendants: number[] = [];
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    descendants.push(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function readProcessGroupId(pid: number): number | undefined {
  try {
    const raw = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 1024,
    }).trim();
    const pgid = Number(raw);
    return Number.isInteger(pgid) && pgid > 1 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

function canSignalProcessGroup(input: {
  readonly rootPid: number;
  readonly processGroupId: number | undefined;
}): input is { readonly rootPid: number; readonly processGroupId: number } {
  if (input.processGroupId === undefined) {
    return false;
  }
  if (input.processGroupId === input.rootPid) {
    return true;
  }
  return input.processGroupId !== readProcessGroupId(process.pid);
}

const signalPid = (input: {
  readonly pid: number;
  readonly signal: ChildProcess.Signal;
}): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(input.pid, input.signal);
      return true;
    } catch {
      return false;
    }
  });

const signalPosixProcessGroup = (input: {
  readonly processGroupId: number;
  readonly signal: ChildProcess.Signal;
}): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(-input.processGroupId, input.signal);
      return true;
    } catch {
      return false;
    }
  });

const signalProcessTree = (input: {
  readonly label: string;
  readonly rootPid: number;
  readonly processGroupId?: number | undefined;
  readonly descendantPids: ReadonlyArray<number>;
  readonly signal: ChildProcess.Signal;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    let sentToProcessGroup = false;
    const processGroupId = input.processGroupId;
    if (
      processGroupId !== undefined &&
      canSignalProcessGroup({
        rootPid: input.rootPid,
        processGroupId,
      })
    ) {
      sentToProcessGroup = yield* signalPosixProcessGroup({
        processGroupId,
        signal: input.signal,
      });
    }

    for (const pid of input.descendantPids.toReversed()) {
      yield* signalPid({ pid, signal: input.signal });
    }
    yield* signalPid({ pid: input.rootPid, signal: input.signal });

    yield* Effect.logDebug("ACP process tree cleanup signal sent", {
      "acp.process.label": input.label,
      "acp.process.pid": input.rootPid,
      "acp.process.descendant_pids": input.descendantPids,
      "acp.process.signal": input.signal,
      "acp.process_group.id": input.processGroupId,
      "acp.process_group.signal_sent": sentToProcessGroup,
      cursor_process_tree_killed: input.signal === "SIGKILL",
    });
  }).pipe(Effect.ignore);

export const terminateAcpProcessTree = (input: {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly label: string;
  readonly grace?: Duration.Input;
}): Effect.Effect<void> => {
  const grace = input.grace ?? ACP_PROCESS_TERMINATE_GRACE;
  return Effect.sync(() => {
    const rootPid = Number(input.child.pid);
    return {
      rootPid,
      processGroupId: process.platform === "win32" ? undefined : readProcessGroupId(rootPid),
      descendantPids: process.platform === "win32" ? ([] as const) : collectDescendantPids(rootPid),
    };
  }).pipe(
    Effect.flatMap(({ rootPid, processGroupId, descendantPids }) =>
      signalProcessTree({
        label: input.label,
        rootPid,
        processGroupId,
        descendantPids,
        signal: "SIGTERM",
      }).pipe(
        Effect.andThen(realSleep(grace)),
        Effect.andThen(
          signalProcessTree({
            label: input.label,
            rootPid,
            processGroupId,
            descendantPids,
            signal: "SIGKILL",
          }),
        ),
      ),
    ),
    Effect.ignore,
  );
};
