import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
  AuthTerminalOperateScope,
  extensionWorkspaceRevision,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  TerminalProviderInstanceNotFoundError,
} from "@t3tools/contracts";
import type { HostApiInvocationMetadata } from "@t3tools/extension-runtime";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";

import { createTerminalOutputEventsApiProvider } from "../extensions/terminalOutputEventsApi.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "./Manager.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  writeFailure: unknown | undefined;
  resizeFailure: unknown | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  killed = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    if (this.writeFailure !== undefined) {
      throw this.writeFailure;
    }
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.resizeFailure !== undefined) {
      throw this.resizeFailure;
    }
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private readonly mode: "sync" | "async";
  private nextPid = 9000;
  spawnGate: Deferred.Deferred<void> | null = null;
  spawnStarted: Deferred.Deferred<void> | null = null;

  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    if (this.spawnGate) {
      const gate = this.spawnGate;
      if (this.spawnStarted) Deferred.doneUnsafe(this.spawnStarted, Effect.void);
      return Deferred.await(gate).pipe(Effect.andThen(this.spawnNow(input)));
    }
    return this.spawnNow(input);
  }

  private spawnNow(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({
          adapter: "fake",
          shell: input.shell,
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "fake",
            shell: input.shell,
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 800,
): Effect.Effect<void, WaitForConditionError | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

const historyLogPath = (logsDir: string, threadId = "thread-1") =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => join(logsDir, `terminal_${Encoding.encodeBase64Url(threadId)}.log`)),
  );

const multiTerminalHistoryLogPath = (
  logsDir: string,
  threadId = "thread-1",
  terminalId = DEFAULT_TERMINAL_ID,
) =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => {
      const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
      return join(
        logsDir,
        terminalId === DEFAULT_TERMINAL_ID
          ? `${threadPart}.log`
          : `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`,
      );
    }),
  );

interface CreateManagerOptions {
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: (terminalPid: number) => Effect.Effect<{
    readonly hasRunningSubprocess: boolean;
    readonly childCommand: string | null;
    readonly processIds: ReadonlyArray<number>;
  }>;
  processTable?: Effect.Effect<
    ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly name: string }>,
    never
  >;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  historyByteLimit?: number;
  ptyAdapter?: FakePtyAdapter;
  resolveProviderInstanceEnvironment?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["resolveProviderInstanceEnvironment"];
  unregisterTerminal?: Parameters<typeof TerminalManager.makeWithOptions>[0]["unregisterTerminal"];
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManager.TerminalManager["Service"];
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ProcessRunner.ProcessRunner
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-" });
      const logsDir = join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.historyByteLimit !== undefined
          ? { historyByteLimit: options.historyByteLimit }
          : {}),
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.processTable !== undefined ? { processTable: options.processTable } : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.resolveProviderInstanceEnvironment !== undefined
          ? { resolveProviderInstanceEnvironment: options.resolveProviderInstanceEnvironment }
          : {}),
        ...(options.unregisterTerminal !== undefined
          ? { unregisterTerminal: options.unregisterTerminal }
          : {}),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

const withHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcessPlatform, platform);

const outputEventsContext = {
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId: "project",
    threadId: "thread-1",
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision(process.cwd(), null),
} as const;

const outputEventsMetadata: HostApiInvocationMetadata = {
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: "t3.host-terminal-output-events",
  providerGeneration: 1,
  callerGenerations: [],
  principal: {
    kind: "environment-session",
    id: "session",
    environmentId: "env",
    scopes: [AuthTerminalOperateScope],
  },
};

const outputEventsProvider = (manager: ManagerFixture["manager"]) =>
  createTerminalOutputEventsApiProvider({
    environmentId: "env",
    projects: {
      getById: (input: { projectId: ProjectId }) =>
        Effect.succeed(
          Option.some({
            projectId: input.projectId,
            workspaceRoot: process.cwd(),
            deletedAt: null,
          }),
        ),
    },
    threads: {
      getById: () =>
        Effect.succeed(
          Option.some({
            projectId: ProjectId.make("project"),
            worktreePath: null,
            deletedAt: null,
          }),
        ),
    },
    terminal: manager,
  });

type OutputEventsWireItem = {
  readonly type: string;
  readonly value: Record<string, unknown>;
};

const nextOutputEventFrame = (iterator: AsyncIterator<unknown>) =>
  Effect.promise(() => iterator.next() as Promise<IteratorResult<OutputEventsWireItem>>);

// Apply the existing line policy, then find the longest code-point-aligned
// byte tail — then advance the cut through any control sequence it lands
// inside, matching the history's sequence-aware eviction boundary.
function retainedHistory(text: string, maxLines: number, maxBytes = Infinity): string {
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  const retained = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  let capped = terminated ? `${retained}\n` : retained;
  if (Buffer.byteLength(capped) > maxBytes) {
    const points = Array.from(capped);
    let start = points.length;
    let bytes = 0;
    while (start > 0) {
      const next = Buffer.byteLength(points[start - 1]!);
      if (bytes + next > maxBytes) break;
      bytes += next;
      start -= 1;
    }
    capped = points.slice(start).join("");
  }
  // The dropped prefix determines the sequence state at the cut; a retained
  // head continuing an evicted sequence is dropped through its end.
  const dropped = text.slice(0, text.length - capped.length);
  const state = TerminalManager.scanTerminalSequenceState(dropped, "none").state;
  if (state === "none") return capped;
  const { endIndex } = TerminalManager.scanTerminalSequenceState(capped, state);
  return endIndex === null ? "" : capped.slice(endIndex);
}

it("preserves line and byte limits across arbitrary chunks, Unicode, ANSI sequences, and clear", () => {
  let randomSeed = 0x20260904;
  const fragments = [
    "",
    "a",
    "\n",
    "\n\n",
    "\r",
    "\r\n",
    "café",
    "名",
    "🚀",
    "\u001b[31m",
    "\u001b[0m",
    "\u001b]8;;url\u0007",
    "\ud83d",
    "\ude80",
  ];
  const nextFragment = () => {
    randomSeed = (Math.imul(randomSeed, 1_664_525) + 1_013_904_223) >>> 0;
    return fragments[randomSeed % fragments.length]!;
  };

  for (const maxBytes of [0, 3, 8, 64, Infinity]) {
    for (const maxLines of [0, 1, 3, 5, 5_000]) {
      let expected = retainedHistory("before\ninitial\n", maxLines, maxBytes);
      const history = new TerminalManager.BoundedTerminalHistory(
        maxLines,
        "before\ninitial\n",
        maxBytes,
      );
      expect(history.value()).toBe(expected);

      for (let step = 0; step < 300; step += 1) {
        if (step % 73 === 0) {
          history.clear();
          expected = "";
          expect(history.value()).toBe(expected);
        }
        const chunk = nextFragment() + nextFragment();
        history.append(chunk);
        expected = retainedHistory(expected + chunk, maxLines, maxBytes);
        expect(history.value()).toBe(expected);
      }
    }
  }
});

it("bounds long partial lines and joins surrogate pairs across chunk boundaries", () => {
  const maxBytes = 65_539;
  let expected = "";
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", maxBytes);
  const writes = [
    "a".repeat(16_383) + "😀" + "b".repeat(70_000),
    "\r" + "c".repeat(70_000) + "\ud83d",
    "\ude80" + "d".repeat(100),
    "\uFEFF" + "名".repeat(30_000),
  ];
  for (const text of writes) {
    history.append(text);
    expected = retainedHistory(expected + text, 5_000, maxBytes);
    expect(history.value()).toBe(expected);
    expect(Buffer.byteLength(history.value())).toBeLessThanOrEqual(maxBytes);
  }
});

it("reads a bounded UTF-8-safe retained tail", () => {
  const history = new TerminalManager.BoundedTerminalHistory(
    5_000,
    "prefix-" + "x".repeat(8_200) + "😀",
  );
  const tail = history.tail(8_192, 8_192);
  expect(tail.retainedByteLength).toBe(Buffer.byteLength(history.value()));
  expect(tail.truncated).toBe(true);
  expect(tail.contents.endsWith("😀")).toBe(true);
  expect(Buffer.byteLength(tail.contents)).toBeLessThanOrEqual(8_192);
  expect(tail.contents.length).toBeLessThanOrEqual(8_192);
});

it("stops at a non-fitting code point across history chunks", () => {
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", 32_768);
  history.append("a".repeat(16_383));
  history.append("😀");
  const tail = history.tail(3, 8_192);
  expect(tail.contents).toBe("");
  expect(tail.truncated).toBe(true);
});

it("rejects invalid tail bounds and preserves split surrogate retention", () => {
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", 32);
  expect(() => history.tail(-1, 8)).toThrow();
  expect(() => history.tail(8, -1)).toThrow();
  expect(() => history.tail(Number.NaN, 8)).toThrow();
  expect(() => history.tail(1.5, 8)).toThrow();
  expect(history.tail(0, 0)).toEqual({
    contents: "",
    retainedByteLength: 0,
    truncated: false,
  });
  history.append(String.fromCharCode(0xd83d));
  history.append(String.fromCharCode(0xde00));
  expect(history.tail(8, 8).contents).toBe("😀");
  const lone = new TerminalManager.BoundedTerminalHistory(5_000, "", 32);
  lone.append(String.fromCharCode(0xd83d));
  expect(lone.tail(8, 8)).toMatchObject({
    contents: "�",
    retainedByteLength: 3,
    truncated: false,
  });
  lone.append(String.fromCharCode(0xde00));
  expect(lone.tail(8, 8)).toMatchObject({
    contents: "😀",
    retainedByteLength: 4,
    truncated: false,
  });
  expect(lone.value()).toBe("😀");
  history.clear();
  expect(history.tail(8, 8)).toEqual({
    contents: "",
    retainedByteLength: 0,
    truncated: false,
  });
});

it("reports independent byte accounting after line and byte trimming", () => {
  const history = new TerminalManager.BoundedTerminalHistory(2, "", 12);
  const writes = "12345\nabcdef\n😀z";
  history.append(writes);
  const expected = retainedHistory(writes, 2, 12);
  expect(history.tail(8_192, 8_192).contents).toBe(expected);
  expect(history.tail(8_192, 8_192).retainedByteLength).toBe(Buffer.byteLength(expected));
});

it("preserves retained lines as older storage is compacted", () => {
  for (const maxLines of [3, 5_000]) {
    let expected = "";
    const history = new TerminalManager.BoundedTerminalHistory(maxLines, expected);
    for (let batch = 0; batch < 40; batch += 1) {
      const chunk = Array.from({ length: 300 }, (_, line) => `${batch}:${line}\n`).join("");
      history.append(chunk);
      expected = retainedHistory(expected + chunk, maxLines);
      expect(history.value()).toBe(expected);
    }
  }
});

it("suppresses a stripped query fragment at every eviction offset inside the sequence", () => {
  // Byte eviction that lands inside a control sequence left a
  // dangling fragment ("6n…") whose prefix was evicted; both read-side
  // sanitizers then surfaced it as visible text. The retained origin must
  // advance through the sequence end, for every split point and every
  // append framing of the query.
  const query = "\x1b[6n";
  const maxBytes = 8;
  for (let offset = 0; offset <= query.length; offset += 1) {
    const tail = "x".repeat(maxBytes + offset - query.length);
    for (let split = 0; split <= query.length; split += 1) {
      const history = new TerminalManager.BoundedTerminalHistory(5_000, "", maxBytes);
      history.append(query.slice(0, split));
      history.append(query.slice(split) + tail);
      // The retained raw window starts at a sequence boundary: when the cut
      // lands inside the query the fragment is dropped, and even offset 0
      // retains the whole query rather than a suffix of it.
      expect(history.value(), `offset=${offset} split=${split}`).toBe(
        offset === 0 ? query + tail : tail,
      );
      expect(history.sanitizedValue(), `sanitized offset=${offset} split=${split}`).toBe(tail);
      expect(history.sanitizedTail(8_192, 8_192).contents).toBe(tail);
      // Raw origins stay exact: the retained window starts past the query
      // (or at 0 when nothing was evicted), never inside it.
      expect(history.appendedUnitLength - history.value().length).toBe(
        offset === 0 ? 0 : query.length,
      );
    }
  }
});

it("suppresses fragments of every stripped sequence class at the eviction boundary", () => {
  const cases: Array<[name: string, sequence: string, terminatorTail: string]> = [
    ["C1 CSI", "\x9b6n", "6n"],
    ["OSC BEL", "\x1b]10;?\x07", "?\x07"],
    ["OSC ST", "\x1b]10;?ab\x1b\\", "b\x1b\\"],
    ["DCS ST", "\x1bP+q544e\x1b\\", "e\x1b\\"],
    ["escape intermediates", "\x1b)0", ")0"],
  ];
  for (const [name, sequence, terminatorTail] of cases) {
    // The byte cut lands inside `sequence` immediately before
    // `terminatorTail`; the retained fragment must be dropped whole.
    const head = sequence.slice(0, sequence.length - terminatorTail.length);
    const tail = "x".repeat(16);
    const history = new TerminalManager.BoundedTerminalHistory(
      5_000,
      "",
      terminatorTail.length + tail.length,
    );
    history.append(head + terminatorTail + tail);
    expect(history.value(), name).toBe(tail);
    expect(history.sanitizedValue(), name).toBe(tail);
    expect(history.sanitizedTail(8_192, 8_192).contents, name).toBe(tail);
  }
});

it("drops a retained window that is still inside an unterminated sequence", () => {
  // An unterminated OSC at the retained head has no visible content; when
  // the stream later terminates it, retention resumes after the terminator.
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", 8);
  history.append("\x1b]10;?" + "a".repeat(16));
  expect(history.value()).toBe("");
  history.append("bc\x07done\n");
  expect(history.value()).toBe("done\n");
  expect(history.sanitizedValue()).toBe("done\n");
});

it("drops a dangling fragment of a non-stripped sequence rather than leaking it as text", () => {
  // Even a sequence the sanitizer keeps (SGR) cannot be reconstructed once
  // its start is evicted — the fragment is dropped instead of surfacing.
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", 8);
  history.append("\x1b[31m" + "x".repeat(4));
  expect(history.value()).toBe("x".repeat(4));
  expect(history.sanitizedValue()).toBe("x".repeat(4));
});

it("suppresses fragments cut by line eviction inside a control sequence", () => {
  // A newline inside a CSI counts as a line break; dropping that line can
  // land the retained origin inside the sequence just like byte eviction.
  const history = new TerminalManager.BoundedTerminalHistory(1, "", 8_192);
  history.append("prompt$ \x1b[6\nn" + "x".repeat(8));
  expect(history.value()).toBe("x".repeat(8));
  expect(history.sanitizedValue()).toBe("x".repeat(8));
});

it("recognizes BEL and C1 ST as string terminators even right after an ESC", () => {
  // An ESC inside a string re-arms the ST check, but BEL and
  // C1 ST still terminate the sequence at their own position — the r12
  // boundary tracker missed that and discarded valid retained output.
  for (const terminator of ["\x07", "\x9c", "\x1b\\"]) {
    const sequence = `\x1b]10;?a\x1b${terminator}`;
    const history = new TerminalManager.BoundedTerminalHistory(5_000, "", sequence.length - 1 + 4);
    history.append(sequence + "KEEP");
    expect(history.value(), JSON.stringify(terminator)).toBe("KEEP");
    expect(history.sanitizedValue()).toBe("KEEP");
    expect(history.sanitizedTail(8_192, 8_192).contents).toBe("KEEP");
    expect(history.appendedUnitLength - history.value().length).toBe(sequence.length);
  }
  // Same cut through the line-eviction path: the newline inside the OSC
  // counts as a line break, so line trimming lands mid-string too.
  const byLine = new TerminalManager.BoundedTerminalHistory(1, "", 8_192);
  byLine.append("pad\n\x1b]10;?a\nb\x1b\x07KEEP");
  expect(byLine.value()).toBe("KEEP");
});

it("retains ordinary output after a boundary-aligned sequence ends", () => {
  // Cascade case: a stale boundary state dropped everything
  // retained until another terminator, and subsequent trims kept
  // discarding ordinary output that arrived after the real terminator.
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", 11);
  history.append("\x1b]10;?\x1b\x07KEEP");
  expect(history.value()).toBe("KEEP");
  history.append("MORE!");
  expect(history.value()).toBe("KEEPMORE!");
  history.append("zzz\nend\n");
  expect(history.value()).toBe("RE!zzz\nend\n");
  expect(history.sanitizedValue()).toBe("RE!zzz\nend\n");
  expect(history.sanitizedTail(8_192, 8_192).contents).toBe("RE!zzz\nend\n");
});

it("drops a retroactively-ended escape only through its true end", () => {
  // findEscapeSequenceEndIndex quirk: intermediates scan speculatively, and
  // a non-final byte ends the sequence at `start + 1` — the intermediates
  // and the deciding byte are ordinary text and must be retained.
  const boundaryInside = new TerminalManager.BoundedTerminalHistory(5_000, "", 4);
  boundaryInside.append("\x1b))\x01abc");
  // Evicted "\x1b))" leaves the sequence open; the retained "\x01" ends it
  // before the retained head — nothing is dropped.
  expect(boundaryInside.value()).toBe("\x01abc");
  const boundaryAtEsc = new TerminalManager.BoundedTerminalHistory(5_000, "", 6);
  boundaryAtEsc.append("\x1b))\x01abc");
  // Evicted "\x1b": the sequence is "ESC)" — only the first intermediate is
  // dropped; the second ")" and the rest are text.
  expect(boundaryAtEsc.value()).toBe(")\x01abc");
});

it("decides an intermediates run over the whole retained window, not per chunk", () => {
  // A non-final byte ends an escape retroactively at its
  // first byte, so intermediates-only chunks are ordinary text — but a
  // chunk-local drop discarded them before the deciding byte in a later
  // chunk was ever scanned. MAX_HISTORY_CHUNK_LENGTH is 16384, so this
  // input splits the intermediates across chunks.
  const input = `\x1b${")".repeat(16_384)}\x01KEEP`;
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", 16_384);
  history.append(input);
  // The escape is "ESC)" (ends at unit 2); evicting 6 units leaves pure
  // text — nothing may be dropped past the real sequence end.
  expect(history.value()).toBe(input.slice(6));
  expect(history.value().length).toBe(16_384);
  expect(history.sanitizedValue()).toBe(input.slice(6));
  const tail = history.sanitizedTail(8_192, 8_192);
  expect(tail.contents).toBe(input.slice(input.length - 8_192));
  expect(history.appendedUnitLength - tail.contents.length).toBe(8_198);
});

it("drops an intermediates run through a final byte even across chunks", () => {
  // Near-boundary variant: same shape, but the run ends with a real final
  // byte — then the intermediates ARE sequence content and the drop must
  // reach the true end in a later chunk.
  const input = `\x1b${")".repeat(16_384)}XKEEP`;
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", 16_384);
  history.append(input);
  expect(history.value()).toBe("KEEP");
  expect(history.sanitizedValue()).toBe("KEEP");
  expect(history.sanitizedTail(8_192, 8_192).contents).toBe("KEEP");
  expect(history.appendedUnitLength - history.value().length).toBe(input.length - 4);
  // And the decision still holds after a later eviction: four more
  // intermediates leave the window, and the remaining ones stay text.
  const boundary = new TerminalManager.BoundedTerminalHistory(5_000, "", 16_384);
  boundary.append(`\x1b${")".repeat(16_384)}\x01KEEP`);
  boundary.append("tail");
  expect(boundary.value()).toBe(`${")".repeat(16_375)}\x01KEEPtail`);
});

it("locates a retroactive escape end in window coordinates across chunks", () => {
  // The deciding non-final byte can sit in a later chunk
  // than the first intermediate — endIndex===0 was then read as "ended
  // before the window", but the true endpoint is window offset 1.
  const input = "p".repeat(16_382) + "\x1b))\x01" + "K".repeat(16_382);
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", 16_385);
  history.append(input);
  // The escape is "ESC)" (input units 16382–16383); the cut at 16383
  // leaves one dangling ')', dropped through window offset 1.
  expect(history.value()).toBe(input.slice(16_384));
  expect(history.value().length).toBe(16_384);
  expect(history.value().startsWith(")\x01KKK")).toBe(true);
  expect(history.appendedUnitLength - history.value().length).toBe(16_384);
  expect(history.sanitizedValue()).toBe(input.slice(16_384));
  expect(history.sanitizedTail(8_192, 8_192).contents).toBe(input.slice(input.length - 8_192));

  // Variant where the endpoint IS before the window: the first
  // intermediate was evicted with the ESC, so nothing is dropped.
  const beforeWindow = new TerminalManager.BoundedTerminalHistory(5_000, "", 16_385);
  const before = "p".repeat(16_381) + "\x1b)))" + "\x01" + "K".repeat(16_382);
  beforeWindow.append(before);
  // Escape = "ESC)" (units 16381–16382); cut at 16383 retains only text.
  expect(beforeWindow.value()).toBe(before.slice(16_383));
  expect(beforeWindow.value().length).toBe(16_385);

  // Variant with a real mid-window endpoint: the run ends with a final
  // byte inside the window, so the drop reaches it exactly.
  const midWindow = new TerminalManager.BoundedTerminalHistory(5_000, "", 16_384);
  const mid = "p".repeat(16_382) + "\x1b)))X" + "K".repeat(16_380);
  midWindow.append(mid);
  // Escape = "ESC)))X" (units 16382–16387); cut at 16383 drops through it.
  expect(midWindow.value()).toBe("K".repeat(16_380));
  expect(midWindow.appendedUnitLength - midWindow.value().length).toBe(16_387);
});

it("carries the retroactive endpoint across a storage seam inside the window", () => {
  // The boundary scan walks chunks without joining; the escape's
  // retroactive end must survive intermediates that cross the 16 KiB
  // storage seam, with the deciding byte in a later chunk.
  const input = "p".repeat(100) + "\x1b" + ")".repeat(16_384) + "\x01KEEP";
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", 16_389);
  history.append(input);
  // Evicted "p"×100 + ESC leaves entry state "escape": the first
  // intermediate sits at window offset 0, so the escape ends
  // retroactively at window offset 1 — proven only when chunk 2's \x01
  // is scanned after 16_283 intermediates in chunk 1.
  expect(history.value()).toBe(input.slice(102));
  expect(history.value().length).toBe(16_388);
  expect(history.appendedUnitLength - history.value().length).toBe(102);
  expect(history.sanitizedValue()).toBe(input.slice(102));

  // Same seam, but the first intermediate was evicted too: the endpoint
  // is before the window and nothing is dropped.
  const evictedStart = new TerminalManager.BoundedTerminalHistory(5_000, "", 16_387);
  evictedStart.append("p".repeat(100) + "\x1b))" + ")".repeat(16_382) + "\x01KEEP");
  expect(evictedStart.value()).toBe(")".repeat(16_382) + "\x01KEEP");
  expect(evictedStart.value().length).toBe(16_387);
});

it("never joins the retained window while aligning a sequence boundary", () => {
  // Performance contract: boundary alignment scans chunks in place —
  // value() must not be called from the append/trim path at all.
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", 8 * 1024);
  let valueCalls = 0;
  const value = history.value.bind(history);
  history.value = () => {
    valueCalls += 1;
    return value();
  };
  for (let index = 0; index < 64; index += 1) {
    history.append("\x1b[31m" + "x".repeat(508));
  }
  expect(valueCalls).toBe(0);
  expect(history.value().length).toBeLessThanOrEqual(8 * 1024);
});

// The sanitizer's own parse as a span oracle: every sequence's extent per
// sanitizeTerminalHistoryChunk's grammar, using its actual helpers.
function sequenceSpans(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  let index = 0;
  while (index < text.length) {
    const codePoint = text.charCodeAt(index);
    let end: number | null = null;
    if (codePoint === 0x1b) {
      const next = text.charCodeAt(index + 1);
      if (Number.isNaN(next)) end = null;
      else if (next === 0x5b) {
        let cursor = index + 2;
        while (cursor < text.length && !TerminalManager.isCsiFinalByte(text.charCodeAt(cursor)))
          cursor += 1;
        end = cursor < text.length ? cursor + 1 : null;
      } else if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f) {
        end = TerminalManager.findStringTerminatorIndex(text, index + 2);
      } else {
        end = TerminalManager.findEscapeSequenceEndIndex(text, index + 1);
      }
    } else if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < text.length && !TerminalManager.isCsiFinalByte(text.charCodeAt(cursor)))
        cursor += 1;
      end = cursor < text.length ? cursor + 1 : null;
    } else if (
      codePoint === 0x9d ||
      codePoint === 0x90 ||
      codePoint === 0x9e ||
      codePoint === 0x9f
    ) {
      end = TerminalManager.findStringTerminatorIndex(text, index + 1);
    }
    if (
      end !== null ||
      codePoint === 0x1b ||
      codePoint === 0x9b ||
      codePoint === 0x9d ||
      codePoint === 0x90 ||
      codePoint === 0x9e ||
      codePoint === 0x9f
    ) {
      // An unterminated sequence runs to the end of the input, like the
      // sanitizer's pendingControlSequence.
      const spanEnd = end ?? text.length;
      spans.push([index, spanEnd]);
      index = spanEnd;
      continue;
    }
    index += 1;
  }
  return spans;
}

it("boundary tracking drops exactly what the sanitizer grammar marks as sequence", () => {
  const texts = [
    "plain text only",
    "a\x1b[31mb",
    "a\x1b[6nb",
    "a\x9b6nb",
    "unterminated\x1b[12",
    "x\x1b]10;?y\x07z",
    "x\x1b]10;?y\x1b\\z",
    "x\x1b]10;?y\x9cz",
    "x\x1bP+q544e\x1b\\z",
    "x\x9d10;?y\x07z",
    "x\x1b]a\x1bb\x07z",
    "x\x1b]a\x1b\x07z",
    "x\x1b]a\x1b\x9cz",
    "x\x1b]a\x1b\x1b\\z",
    "x\x1b]never ends",
    "x\x1b]ends in esc\x1b",
    "a\x1bZb",
    "a\x1b)0b",
    "a\x1b))\x01b",
    "a\x1b))\x9b6nb",
    "a\x1b[6nb\x1b]x\x07c\x1bZd\x1b",
    "x\n\x1b[6\nnY",
  ];
  for (const text of texts) {
    const spans = sequenceSpans(text);
    for (let cut = 0; cut <= text.length; cut += 1) {
      const inside = spans.find(([start, end]) => start < cut && cut < end);
      const suffix = text.slice(cut);
      const mid = TerminalManager.scanTerminalSequenceState(text.slice(0, cut), "none");
      const actualDrop =
        mid.state === "none"
          ? 0
          : (TerminalManager.scanTerminalSequenceState(suffix, mid.state).endIndex ??
            suffix.length);
      const expectedDrop = inside === undefined ? 0 : inside[1] - cut;
      expect(actualDrop, `${JSON.stringify(text)} cut=${cut} spans=${JSON.stringify(spans)}`).toBe(
        expectedDrop,
      );
    }
  }
});

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("TerminalManager", (it) => {
  it.effect("spawns lazily and reuses running terminal per thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const [first, second] = yield* Effect.all(
        [manager.open(openInput()), manager.open(openInput())],
        { concurrency: "unbounded" },
      );
      const third = yield* manager.open(openInput());

      assert.equal(first.threadId, "thread-1");
      assert.equal(first.terminalId, DEFAULT_TERMINAL_ID);
      assert.equal(second.threadId, "thread-1");
      assert.equal(third.threadId, "thread-1");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("attaches to running sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();

      yield* manager.open(openInput());
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 100,
          rows: 40,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.threadId, "thread-1");
      assert.equal(snapshot.snapshot.terminalId, DEFAULT_TERMINAL_ID);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("observes an existing terminal with an acquired snapshot boundary", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const outputSeen = yield* Deferred.make<void>();
      const events: TerminalManager.TerminalOutputObservationEvent[] = [];
      const unsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => {
          events.push(event);
          if (event.type === "output") Deferred.doneUnsafe(outputSeen, Effect.void);
        },
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      expect(events[0]?.type).toBe("snapshot");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      ptyAdapter.processes[0]!.emitData("after snapshot");
      yield* Deferred.await(outputSeen);
      expect(events.filter((event) => event.type === "output")).toHaveLength(1);
      expect(events.find((event) => event.type === "output")).toMatchObject({
        data: "after snapshot",
      });
      expect(ptyAdapter.processes[0]!.writes).toHaveLength(0);
      expect(ptyAdapter.processes[0]!.resizeCalls).toHaveLength(0);
    }),
  );

  it.effect("returns only an exited snapshot and emits clear/close lifecycle observations", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const exited = yield* Deferred.make<void>();
      const legacyUnsubscribe = yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Effect.sync(() => {
              Deferred.doneUnsafe(exited, Effect.void);
            })
          : Effect.void,
      );
      ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: 0 });
      yield* Deferred.await(exited);
      yield* Effect.sync(legacyUnsubscribe);

      const exitedEvents: TerminalManager.TerminalOutputObservationEvent[] = [];
      const exitedUnsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => exitedEvents.push(event),
      );
      yield* Effect.sync(exitedUnsubscribe);
      expect(exitedEvents).toHaveLength(2);
      expect(exitedEvents[0]).toMatchObject({ type: "snapshot", snapshot: { status: "exited" } });
      expect(exitedEvents[1]).toMatchObject({ type: "exited" });

      yield* manager.open(openInput());
      const cleared = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const events: TerminalManager.TerminalOutputObservationEvent[] = [];
      const unsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => {
          events.push(event);
          if (event.type === "cleared") Deferred.doneUnsafe(cleared, Effect.void);
          if (event.type === "closed") Deferred.doneUnsafe(closed, Effect.void);
        },
      );
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* Deferred.await(cleared);
      yield* manager.close({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* Deferred.await(closed);
      yield* Effect.sync(unsubscribe);
      expect(events.map((event) => event.type)).toEqual(["snapshot", "cleared", "closed"]);
    }),
  );

  it.effect("bumps the snapshot clear generation across a history clear", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput());
      const snapshotGeneration = () => {
        const events: TerminalManager.TerminalOutputObservationEvent[] = [];
        return Effect.gen(function* () {
          const unsubscribe = yield* manager.subscribeOutput(
            { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
            (event) => events.push(event),
          );
          yield* Effect.sync(unsubscribe);
          const snapshot = events.find((event) => event.type === "snapshot");
          return snapshot?.type === "snapshot" ? snapshot.clearGeneration : -1;
        });
      };
      expect(yield* snapshotGeneration()).toBe(0);
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      expect(yield* snapshotGeneration()).toBe(1);
    }),
  );

  it.effect("reports the absolute retained-window origin across line eviction", () =>
    Effect.gen(function* () {
      // 5-line limit: a burst of short lines evicts the head while the
      // retained tail still fits under the snapshot byte cap, so the
      // snapshot arrives untruncated — only contentsUnitStart reveals
      // that units were dropped from the front of the window.
      const { manager, ptyAdapter } = yield* createManager(5);
      yield* manager.open(openInput());
      const drained = yield* Deferred.make<void>();
      const drainUnsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => {
          if (event.type === "output" && event.data.endsWith("last\n"))
            Deferred.doneUnsafe(drained, Effect.void);
        },
      );
      yield* Effect.addFinalizer(() => Effect.sync(drainUnsubscribe));
      ptyAdapter.processes[0]!.emitData("q\n" + "x\n".repeat(10) + "last\n");
      yield* Deferred.await(drained);

      const events: TerminalManager.TerminalOutputObservationEvent[] = [];
      const unsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => events.push(event),
      );
      yield* Effect.sync(unsubscribe);
      const snapshot = events.find((event) => event.type === "snapshot");
      if (!snapshot || snapshot.type !== "snapshot") return assert.fail("missing snapshot");
      // totalUnits = 2 + 20 + 5 = 27; retained tail = last 5 lines.
      const expected = 27 - snapshot.snapshot.contents.length;
      expect(snapshot.contentsUnitStart).toBe(expected);
      expect(snapshot.contentsUnitStart).toBeGreaterThan(0);
      expect(snapshot.clearGeneration).toBe(0);
      expect(snapshot.snapshot.truncated).toBe(false);
      expect(snapshot.snapshot.contents.startsWith("q")).toBe(false);
    }),
  );

  it.effect("a history clear restarts the retained window at unit origin 0", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5);
      yield* manager.open(openInput());
      const cleared = yield* Deferred.make<void>();
      const events: TerminalManager.TerminalOutputObservationEvent[] = [];
      const unsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => {
          events.push(event);
          if (event.type === "cleared") Deferred.doneUnsafe(cleared, Effect.void);
        },
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      ptyAdapter.processes[0]!.emitData("before\n");
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* Deferred.await(cleared);
      const clearedEvent = events.find((event) => event.type === "cleared");
      expect(clearedEvent).toMatchObject({ type: "cleared", clearGeneration: 1 });

      const drained = yield* Deferred.make<void>();
      const drainUnsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => {
          if (event.type === "output" && event.data.endsWith("after\n"))
            Deferred.doneUnsafe(drained, Effect.void);
        },
      );
      yield* Effect.addFinalizer(() => Effect.sync(drainUnsubscribe));
      ptyAdapter.processes[0]!.emitData("after\n");
      yield* Deferred.await(drained);

      const post: TerminalManager.TerminalOutputObservationEvent[] = [];
      const postUnsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => post.push(event),
      );
      yield* Effect.sync(postUnsubscribe);
      const snapshot = post.find((event) => event.type === "snapshot");
      if (!snapshot || snapshot.type !== "snapshot") return assert.fail("missing snapshot");
      expect(snapshot.contentsUnitStart).toBe(0);
      expect(snapshot.clearGeneration).toBe(1);
      expect(snapshot.snapshot.contents).toBe("after\n");
    }),
  );

  it.effect("retains raw output so evicted-byte provenance stays absolute", () =>
    Effect.gen(function* () {
      // The sanitizer removes the answered CSI 6n from display text but the
      // retained window — and therefore contentsUnitStart — must count the
      // raw delivered stream. With a 5-line cap the eviction burst drops the
      // first line: raw origin moves to 7 (the sanitized view would report
      // 3, which is exactly the coordinate confusion a sanitized view
      // would create).
      const { manager, ptyAdapter } = yield* createManager(5);
      yield* manager.open(openInput());
      ptyAdapter.processes[0]!.emitData("\x1b[6n");
      ptyAdapter.processes[0]!.emitData("\x1bZ\n");
      // Attach-path history is the sanitized boundary: the answered query
      // is gone from the replay text while the raw window keeps it.
      const attach = yield* manager.open(openInput());
      expect(attach.history).toBe("\x1bZ\n");

      ptyAdapter.processes[0]!.emitData("x\x1bZ\n" + "z\n".repeat(4));

      const events: TerminalManager.TerminalOutputObservationEvent[] = [];
      const unsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => events.push(event),
      );
      yield* Effect.sync(unsubscribe);
      const snapshot = events.find((event) => event.type === "snapshot");
      if (!snapshot || snapshot.type !== "snapshot") return assert.fail("missing snapshot");
      expect(snapshot.contentsUnitStart).toBe(7);
      expect(snapshot.clearGeneration).toBe(0);
      expect(snapshot.snapshot.truncated).toBe(false);
      expect(snapshot.snapshot.contents).toBe("x\x1bZ\n" + "z\n".repeat(4));
    }),
  );

  it.effect(
    "keeps an incomplete control inside retained contents across the subscription boundary",
    () =>
      Effect.gen(function* () {
        // The subscription lands between the two halves of the bracketed-
        // paste setter. The prefix is retained inside the window rather than
        // held outside it, so the snapshot's coverage claim includes it and
        // the live stream continues the sequence.
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        ptyAdapter.processes[0]!.emitData("\x1b[?2004");

        const events: TerminalManager.TerminalOutputObservationEvent[] = [];
        const unsubscribe = yield* manager.subscribeOutput(
          { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
          (event) => events.push(event),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        const snapshot = events.find((event) => event.type === "snapshot");
        if (!snapshot || snapshot.type !== "snapshot") return assert.fail("missing snapshot");
        expect(snapshot.contentsUnitStart).toBe(0);
        expect(snapshot.clearGeneration).toBe(0);
        expect(snapshot.snapshot.truncated).toBe(false);
        expect(snapshot.snapshot.contents).toBe("\x1b[?2004");

        ptyAdapter.processes[0]!.emitData("h");
        yield* waitFor(
          Effect.sync(() => events.some((event) => event.type === "output" && event.data === "h")),
        );
      }),
  );

  it.effect("resets the clear generation for the next incarnation", () =>
    Effect.gen(function* () {
      // clearGeneration is scoped to the stream epoch: a restart opens a new
      // incarnation whose retained window starts empty at generation 0.
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      ptyAdapter.processes[0]!.emitData("before\n");
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });

      const before: TerminalManager.TerminalOutputObservationEvent[] = [];
      const unsubBefore = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => before.push(event),
      );
      yield* Effect.sync(unsubBefore);
      const epochOne = before.find((event) => event.type === "snapshot");
      if (!epochOne || epochOne.type !== "snapshot") return assert.fail("missing snapshot");
      expect(epochOne.clearGeneration).toBe(1);

      yield* manager.restart(restartInput());

      const events: TerminalManager.TerminalOutputObservationEvent[] = [];
      const unsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => events.push(event),
      );
      yield* Effect.sync(unsubscribe);
      const snapshot = events.find((event) => event.type === "snapshot");
      if (!snapshot || snapshot.type !== "snapshot") return assert.fail("missing snapshot");
      expect(snapshot.sourceEpoch).not.toBe(epochOne.sourceEpoch);
      expect(snapshot.clearGeneration).toBe(0);
      expect(snapshot.contentsUnitStart).toBe(0);
      expect(snapshot.snapshot.contents).toBe("");
    }),
  );

  // Wire-frame contract for detached replay: the exact output-events frames
  // a terminal client consumes in the evicted-query and split-mode-setter
  // scenarios. Every subscription opens with a snapshot, identity
  // (streamEpoch) survives resubscription within one incarnation, and raw
  // retained-window provenance (contentsUnitStart) counts the delivered
  // stream — including bytes the sanitized attach view removes.
  for (const gapQuery of [true, false]) {
    it.effect(
      `pins the output-events wire frames for an evicted query's dead claim (gap tail ${gapQuery ? "queries" : "inert"})`,
      () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter } = yield* createManager(5);
          yield* manager.open(openInput());
          const provider = outputEventsProvider(manager);

          const subscribe = (abort: AbortController) =>
            provider.subscribe!(
              "subscribe",
              { terminalId: DEFAULT_TERMINAL_ID },
              outputEventsContext,
              abort.signal,
              outputEventsMetadata,
            )[Symbol.asyncIterator]();

          const abort1 = new AbortController();
          yield* Effect.addFinalizer(() => Effect.sync(() => abort1.abort()));
          const stream1 = subscribe(abort1);
          const first = yield* nextOutputEventFrame(stream1);
          ptyAdapter.processes[0]!.emitData("\x1b[6n");
          const query = yield* nextOutputEventFrame(stream1);
          ptyAdapter.processes[0]!.emitData("\x1bZ\n");
          const lookalike = yield* nextOutputEventFrame(stream1);
          abort1.abort();

          // Disconnected: the burst evicts the line holding the answered query.
          // The retained tail may carry a new gap query or be inert.
          const gapTail = (gapQuery ? "x\x1bZ\n" : "xyz\n") + "z\n".repeat(4);
          ptyAdapter.processes[0]!.emitData(gapTail);

          const abort2 = new AbortController();
          yield* Effect.addFinalizer(() => Effect.sync(() => abort2.abort()));
          const stream2 = subscribe(abort2);
          const resnapshot = yield* nextOutputEventFrame(stream2);

          // Frame sequence: every subscription opens with a snapshot, and live
          // output arrives as data frames after it.
          expect(first.value.type).toBe("snapshot");
          expect(query.value.type).toBe("data");
          expect(lookalike.value.type).toBe("data");
          expect(resnapshot.value.type).toBe("snapshot");

          // Identity: one incarnation across both subscriptions.
          const epoch = resnapshot.value.value.streamEpoch;
          expect(typeof epoch).toBe("string");
          for (const frame of [first, query, lookalike, resnapshot]) {
            expect(frame.value.value.terminalId).toBe(DEFAULT_TERMINAL_ID);
            expect(frame.value.value.streamEpoch).toBe(epoch);
          }

          // First snapshot: empty window at raw origin 0.
          expect(first.value.value).toMatchObject({
            kind: "snapshot",
            status: "running",
            contents: "",
            retainedByteLength: 0,
            truncated: false,
            clearGeneration: 0,
            contentsUnitStart: 0,
            boundarySequence: 1,
          });

          // The query and the retained lookalike pass through unsanitized.
          expect(query.value.value).toMatchObject({
            kind: "output",
            data: "\x1b[6n",
            sequence: 2,
            chunkIndex: 0,
            chunkCount: 1,
          });
          expect(lookalike.value.value).toMatchObject({
            kind: "output",
            data: "\x1bZ\n",
            sequence: 3,
            chunkIndex: 0,
            chunkCount: 1,
          });

          // Resnapshot: raw provenance. The answered query's bytes were evicted
          // but still counted — the window starts at unit 7, not the sanitized
          // view's 3, so a replayed claim anchored before the window is dead.
          expect(resnapshot.value.value).toMatchObject({
            kind: "snapshot",
            status: "running",
            contents: gapTail,
            truncated: false,
            clearGeneration: 0,
            contentsUnitStart: 7,
            retainedByteLength: 12,
            boundarySequence: 4,
          });
        }),
    );
  }

  it.effect("pins the output-events wire frames across a subscription-split mode setter", () =>
    Effect.gen(function* () {
      // "ESC[?2004" is emitted before the subscription exists; "h" completes
      // it live. The snapshot must carry the raw prefix — coverage includes
      // it — so a client that mounts mid-sequence continues it rather than
      // restarting its parser state.
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const provider = outputEventsProvider(manager);

      ptyAdapter.processes[0]!.emitData("\x1b[?2004");

      const abort = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()));
      const subscription = provider.subscribe!(
        "subscribe",
        { terminalId: DEFAULT_TERMINAL_ID },
        outputEventsContext,
        abort.signal,
        outputEventsMetadata,
      );
      const stream = subscription[Symbol.asyncIterator]();
      const snapshot = yield* nextOutputEventFrame(stream);
      ptyAdapter.processes[0]!.emitData("h");
      const live = yield* nextOutputEventFrame(stream);

      expect(snapshot.value.type).toBe("snapshot");
      expect(live.value.type).toBe("data");
      expect(snapshot.value.value.terminalId).toBe(DEFAULT_TERMINAL_ID);
      expect(snapshot.value.value.streamEpoch).toBe(live.value.value.streamEpoch);
      expect(snapshot.value.value).toMatchObject({
        kind: "snapshot",
        status: "running",
        contents: "\x1b[?2004",
        truncated: false,
        clearGeneration: 0,
        contentsUnitStart: 0,
        retainedByteLength: 7,
        boundarySequence: 2,
      });
      expect(live.value.value).toMatchObject({
        kind: "output",
        data: "h",
        sequence: 3,
        chunkIndex: 0,
        chunkCount: 1,
      });
    }),
  );

  it.effect("terminates an old observation on reincarnation without accepting old identity", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const closed = yield* Deferred.make<void>();
      const events: TerminalManager.TerminalOutputObservationEvent[] = [];
      const unsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => {
          events.push(event);
          if (event.type === "closed") Deferred.doneUnsafe(closed, Effect.void);
        },
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.restart(restartInput());
      yield* Deferred.await(closed);
      expect(events.at(-1)).toMatchObject({ type: "closed", reason: "identity-changed" });
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("does not acquire a new observation while restart still owns the thread lock", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const gate = yield* Deferred.make<void>();
      const spawnStarted = yield* Deferred.make<void>();
      ptyAdapter.spawnGate = gate;
      ptyAdapter.spawnStarted = spawnStarted;

      const restartFiber = yield* manager.restart(restartInput()).pipe(Effect.forkChild);
      yield* Deferred.await(spawnStarted);
      const snapshotSeen = yield* Deferred.make<void>();
      const subscribeFiber = yield* Effect.forkChild(
        manager.subscribeOutput(
          { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
          (event) => {
            if (event.type === "snapshot") Deferred.doneUnsafe(snapshotSeen, Effect.void);
          },
        ),
      );
      expect(Option.isNone(yield* Deferred.poll(snapshotSeen))).toBe(true);

      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(restartFiber);
      const unsubscribe = yield* Fiber.join(subscribeFiber);
      yield* Effect.sync(unsubscribe);
      expect(Option.isSome(yield* Deferred.poll(snapshotSeen))).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("ignores delayed old-source exit publication after reincarnation", () =>
    Effect.gen(function* () {
      const exitUnregisterEntered = yield* Deferred.make<void>();
      const releaseExitUnregister = yield* Deferred.make<void>();
      const oldExitPublished = yield* Deferred.make<void>();
      let holdFirstExitUnregister = true;
      const { manager, ptyAdapter } = yield* createManager(5, {
        unregisterTerminal: () => {
          if (!holdFirstExitUnregister) return Effect.void;
          holdFirstExitUnregister = false;
          return Effect.sync(() => {
            Deferred.doneUnsafe(exitUnregisterEntered, Effect.void);
          }).pipe(Effect.andThen(Deferred.await(releaseExitUnregister)));
        },
      });
      const legacyUnsubscribe = yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Effect.sync(() => {
              Deferred.doneUnsafe(oldExitPublished, Effect.void);
            })
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(legacyUnsubscribe));

      yield* manager.open(openInput());
      const oldEvents: TerminalManager.TerminalOutputObservationEvent[] = [];
      const oldUnsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => oldEvents.push(event),
      );
      yield* Effect.addFinalizer(() => Effect.sync(oldUnsubscribe));
      const oldEpoch = oldEvents[0]?.sourceEpoch;
      const oldProcess = ptyAdapter.processes[0]!;
      oldProcess.emitExit({ exitCode: 17, signal: 0 });
      yield* Deferred.await(exitUnregisterEntered);

      yield* manager.restart(restartInput());
      const freshEvents: TerminalManager.TerminalOutputObservationEvent[] = [];
      const freshUnsubscribe = yield* manager.subscribeOutput(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => freshEvents.push(event),
      );
      yield* Effect.addFinalizer(() => Effect.sync(freshUnsubscribe));
      const freshEpoch = freshEvents[0]?.sourceEpoch;
      expect(freshEvents[0]?.type).toBe("snapshot");
      expect(freshEpoch).toBeDefined();
      expect(freshEpoch).not.toBe(oldEpoch);

      yield* Deferred.succeed(releaseExitUnregister, undefined);
      yield* Deferred.await(oldExitPublished);
      expect(freshEvents).toHaveLength(1);
      expect(freshEvents[0]).toMatchObject({ type: "snapshot", sourceEpoch: freshEpoch });
    }),
  );

  it.effect("keeps attach streams live when a terminal id is closed and reopened", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.open(openInput());

      const events = yield* Ref.get(attachEvents);
      expect(events.map((event) => event.type)).toEqual(["snapshot", "closed", "snapshot"]);
      expect(
        events.filter((event) => event.type === "snapshot").map((event) => event.snapshot.status),
      ).toEqual(["running", "running"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("attaches to exited sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        openInput({
          env: {
            T3CODE_WORKTREE_PATH: "/tmp/should-not-restart",
          },
          worktreePath: "/tmp/should-not-restart",
        }),
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "exited");
      assert.equal(snapshot.snapshot.worktreePath, null);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("restarts inactive sessions from attach only when requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          ...openInput({
            env: {
              T3CODE_WORKTREE_PATH: "/tmp/restart-requested",
            },
            worktreePath: "/tmp/restart-requested",
          }),
          restartIfNotRunning: true,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "running");
      assert.equal(snapshot.snapshot.worktreePath, "/tmp/restart-requested");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  const makeDirectory = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.makeDirectory(filePath, { recursive: true }),
    );

  const chmod = (filePath: string, mode: number) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.chmod(filePath, mode));

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );

  it.effect("reports a missing cwd without an artificial cause", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "missing-cwd");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotFoundError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("reports a cwd that is not a directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "cwd-file");
      yield* writeFileString(cwd, "not a directory");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotDirectoryError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves non-notFound cwd stat failures", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;

      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const blockedRoot = path.join(baseDir, "blocked-root");
      const blockedCwd = path.join(blockedRoot, "cwd");
      yield* makeDirectory(blockedCwd);
      yield* chmod(blockedRoot, 0o000);

      const error = yield* Effect.flip(manager.open(openInput({ cwd: blockedCwd }))).pipe(
        Effect.ensuring(chmod(blockedRoot, 0o755).pipe(Effect.ignore)),
      );

      expect(error).toMatchObject({
        _tag: "TerminalCwdStatError",
        cwd: blockedCwd,
        cause: {
          _tag: "PlatformError",
        },
      });
    }),
  );

  it.effect("supports asynchronous PTY spawn effects", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );

  it.effect("forwards write and resize to active pty process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.writes).toEqual(["ls\n"]);
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("preserves structured context and causes for PTY I/O failures", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const writeCause = new Error("PTY input handle is unavailable");
      process.writeFailure = writeCause;
      const writeError = yield* Effect.flip(
        manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "secret input that must not be attached to the error",
        }),
      );

      expect(writeError).toMatchObject({
        _tag: "TerminalWriteError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
      });
      expect(writeError.cause).toBe(writeCause);
      expect(writeError).not.toHaveProperty("data");

      const resizeCause = new Error("PTY resize handle is unavailable");
      process.resizeFailure = resizeCause;
      const resizeError = yield* Effect.flip(
        manager.resize({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 132,
          rows: 40,
        }),
      );

      expect(resizeError).toMatchObject({
        _tag: "TerminalResizeError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
        cols: 132,
        rows: 40,
      });
      expect(resizeError.cause).toBe(resizeCause);

      process.resizeFailure = undefined;
      yield* manager.open(openInput({ cols: 132, rows: 40 }));
      expect(process.resizeCalls).toEqual([{ cols: 132, rows: 40 }]);
    }),
  );

  it.effect("ignores delayed resize requests after a terminal closes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.resizeCalls).toEqual([]);
    }),
  );

  it.effect("resizes running terminal on open when a different size is requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(openInput({ cols: 120, rows: 30 }));

      assert.equal(reopened.status, "running");
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("supports multiple terminals per thread independently", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
      yield* manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

      expect(first.writes).toEqual(["pwd\n"]);
      expect(second.writes).toEqual(["ls\n"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("clears transcript and emits cleared event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );

      const events = yield* getEvents;
      expect(events.some((event) => event.type === "cleared")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "cleared" &&
            event.threadId === "thread-1" &&
            event.terminalId === DEFAULT_TERMINAL_ID,
        ),
      ).toBe(true);
    }),
  );

  it.effect("restarts terminal with empty transcript and respawns pty", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      firstProcess.emitData("before restart\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      const snapshot = yield* manager.restart(restartInput());
      assert.equal(snapshot.history, "");
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );
    }),
  );

  it.effect("restarts a running session when open is called with a different cwd", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const originalCwd = path.join(baseDir, "original");
      const differentCwd = path.join(baseDir, "different");
      yield* makeDirectory(originalCwd);
      yield* makeDirectory(differentCwd);

      yield* manager.open(openInput({ cwd: originalCwd }));
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;

      firstProcess.emitData("before reopen\n");
      const logPath = yield* historyLogPath(logsDir);
      yield* waitFor(pathExists(logPath));

      const reopened = yield* manager.open(openInput({ cwd: differentCwd }));

      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      assert.equal(firstProcess.killed, true);
      assert.equal(reopened.cwd, differentCwd);
      assert.equal(reopened.history, "");
      yield* waitFor(Effect.map(readFileString(logPath), (text) => text === ""));
    }),
  );

  it.effect("propagates explicit worktree metadata through snapshots and lifecycle events", () =>
    Effect.gen(function* () {
      const { manager, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const firstWorktreePath = path.join(baseDir, "worktrees", "feature-a");
      const secondWorktreePath = path.join(baseDir, "worktrees", "feature-b");
      yield* makeDirectory(firstWorktreePath);
      yield* makeDirectory(secondWorktreePath);
      const startedSnapshot = yield* manager.open(
        openInput({
          cwd: firstWorktreePath,
          worktreePath: firstWorktreePath,
        }),
      );
      const restartedSnapshot = yield* manager.restart(
        restartInput({
          cwd: secondWorktreePath,
          worktreePath: secondWorktreePath,
        }),
      );

      assert.equal(startedSnapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedSnapshot.worktreePath, secondWorktreePath);

      const events = yield* getEvents;
      const startedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
      );
      const restartedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "restarted" }> =>
          event.type === "restarted",
      );

      assert.equal(startedEvent?.snapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedEvent?.snapshot.worktreePath, secondWorktreePath);
    }),
  );

  it.effect("preserves worktree metadata when reopening an exited session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const worktreePath = path.join(baseDir, "worktrees", "feature-a");
      yield* makeDirectory(worktreePath);

      yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      const reopenedSnapshot = yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      assert.equal(reopenedSnapshot.worktreePath, worktreePath);

      const events = yield* getEvents;
      const reopenedEvent = events
        .toReversed()
        .find(
          (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
        );

      assert.equal(reopenedEvent?.snapshot.worktreePath, worktreePath);
    }),
  );

  it.effect("emits exited event and reopens with clean transcript after exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("old data\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const reopened = yield* manager.open(openInput());

      assert.equal(reopened.history, "");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
        ),
      ).toBe("");
    }),
  );

  it.effect("ignores trailing writes after terminal exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\r",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
      } = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      const { manager, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);

      inspect = { hasRunningSubprocess: true, childCommand: "vim", processIds: [100, 101] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      inspect = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === false &&
              event.label === "Terminal 1",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("does not invoke subprocess polling until a terminal session is running", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager } = yield* createManager(5, {
        subprocessInspector: () => {
          checks += 1;
          return Effect.succeed({
            hasRunningSubprocess: false,
            childCommand: null,
            processIds: [],
          });
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.sync(() => checks > 0),
        "1200 millis",
      );
    }),
  );

  it.effect("derives subprocess activity for every terminal from one shared process snapshot", () =>
    Effect.gen(function* () {
      const runCalls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      // FakePtyAdapter assigns pids starting at 9000, so the two terminals
      // opened below run as pids 9000 and 9001.
      const psStdout = ["  100  9000 vim", "  101   100 git", "  200  9001 /usr/bin/python3"].join(
        "\n",
      );
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          Effect.sync(() => {
            runCalls.push({ command: input.command, args: input.args });
            return {
              stdout: psStdout,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(withHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) =>
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "vim",
            ) &&
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "python3",
            ),
        ),
        "1200 millis",
      );
      yield* waitFor(
        Effect.sync(() => runCalls.length >= 3),
        "1200 millis",
      );

      // Every spawn is the shared table snapshot — no per-terminal `pgrep`
      // or per-child `ps -p` invocations.
      expect(runCalls.every((call) => call.args.join(" ") === "-eo pid=,ppid=,comm=")).toBe(true);
    }),
  );

  it.effect("keeps last known subprocess state when the process snapshot fails", () =>
    Effect.gen(function* () {
      let failSnapshots = false;
      let failedCalls = 0;
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Effect.sync(() => {
            if (failSnapshots) failedCalls += 1;
            return {
              stdout: failSnapshots ? "" : "  100  9000 vim",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(failSnapshots ? 1 : 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(withHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      failSnapshots = true;
      yield* waitFor(
        Effect.sync(() => failedCalls >= 3),
        "1200 millis",
      );

      // A failed snapshot is not authoritative: no terminal flips to idle.
      const activityEvents = (yield* getEvents).filter((event) => event.type === "activity");
      expect(activityEvents.length).toBeGreaterThan(0);
      expect(activityEvents.every((event) => event.hasRunningSubprocess === true)).toBe(true);
    }),
  );

  it("calculates snapshot failure backoff and success reset delays", () => {
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 0), 1_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 1), 2_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 2), 4_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 30), 60_000);
  });

  it.effect("uses process snapshots from the resource monitor", () =>
    Effect.gen(function* () {
      let snapshotCalls = 0;
      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTable: Effect.sync(() => {
          snapshotCalls += 1;
          return [{ pid: 100, ppid: 9000, name: "ping.exe" }];
        }),
      }).pipe(Effect.provide(withHostPlatform("win32")));

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" && event.hasRunningSubprocess && event.label === "ping",
          ),
        ),
        "1200 millis",
      );
      expect(snapshotCalls).toBeGreaterThan(0);
    }),
  );

  it.effect("backs off the spawned fallback when the resource monitor snapshot fails", () =>
    Effect.gen(function* () {
      const fallbackCalls: Array<number> = [];
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              fallbackCalls.push(now);
              return {
                stdout: "  100  9000 vim",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrInvalidUtf8: false,
                stdoutInvalidUtf8: false,
                stderrTruncated: false,
              };
            }),
          ),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTable: Effect.fail("sidecar unavailable").pipe(
          Effect.mapError((cause) => cause as never),
        ),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(withHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      // The fallback data is still applied while the sidecar is down.
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      yield* waitFor(
        Effect.sync(() => fallbackCalls.length >= 4),
        "2000 millis",
      );
      // Four snapshots at the 20 ms base cadence would span ~60 ms. Backoff
      // (40 + 80 + 160 ms) stretches the same four snapshots past 150 ms, so
      // a stalled sidecar no longer hot-loops the spawned fallback.
      const spanMs = fallbackCalls[3]! - fallbackCalls[0]!;
      expect(spanMs).toBeGreaterThan(150);
    }),
  );

  it.effect("caps persisted history to configured line limit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\nline2\nline3\nline4\n");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
      expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);
    }),
  );

  it.effect("caps incrementally appended history without losing partial or empty lines", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\n");
      process.emitData("\n");
      process.emitData("line3");
      process.emitData("-continued\nline4");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history).toBe("\nline3-continued\nline4");
    }),
  );

  it.effect("bounds persisted and attached history without truncating live output", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(5, { historyByteLimit: 10 });
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const writes = ["a".repeat(32), "😀\rEND"];
      const process = ptyAdapter.processes[0]!;
      for (const text of writes) process.emitData(text);
      yield* manager.close({ threadId: "thread-1" });
      expect(yield* readFileString(yield* historyLogPath(logsDir))).toBe("aa😀\rEND");

      const reopened = yield* manager.open(openInput());
      const events = yield* Ref.get(attachEvents);
      expect(events.filter((event) => event.type === "output").map((event) => event.data)).toEqual(
        writes,
      );
      const snapshot = events.findLast((event) => event.type === "snapshot")?.snapshot;
      expect(snapshot?.history).toBe("aa😀\rEND");
      expect(snapshot?.sequence).toBe(reopened.sequence);
    }),
  );

  for (const source of ["current", "legacy"] as const) {
    it.effect(`reads only a Unicode-safe tail from oversized ${source} history`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let sourcePath: string | undefined;
        let closedReads = 0;
        const readRequests: number[] = [];
        const trackedFileSystem = FileSystem.FileSystem.of({
          ...fs,
          readFileString: (candidate, encoding) =>
            candidate === sourcePath
              ? Effect.die("History restoration must not read the whole file")
              : fs.readFileString(candidate, encoding),
          open: (candidate, options) =>
            Effect.gen(function* () {
              if (candidate !== sourcePath) return yield* fs.open(candidate, options);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closedReads += 1;
                }),
              );
              const file = yield* fs.open(candidate, options);
              return new Proxy(file, {
                get(target, key) {
                  if (key === "read") {
                    return (buffer: Uint8Array) => {
                      readRequests.push(buffer.byteLength);
                      return target.read(buffer.subarray(0, 5));
                    };
                  }
                  return Reflect.get(target, key, target);
                },
              });
            }),
        });
        const { manager, logsDir } = yield* createManager(5, { historyByteLimit: 15 }).pipe(
          Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        );
        const nextPath = yield* historyLogPath(logsDir);
        sourcePath = source === "current" ? nextPath : path.join(logsDir, "thread-1.log");
        yield* fs.writeFileString(sourcePath, "old".repeat(32_768) + "😀\uFEFFnewest\ré");

        const snapshot = yield* manager.open(openInput());
        expect(snapshot.history).toBe("\uFEFFnewest\ré");
        expect(readRequests).toEqual([15, 10, 5]);
        expect(closedReads).toBe(1);
        expect(Buffer.from(yield* fs.readFile(nextPath)).toString()).toBe("\uFEFFnewest\ré");
        if (source === "legacy") expect(yield* fs.exists(sourcePath)).toBe(false);
        yield* manager.close({ threadId: "thread-1" });
        expect((yield* manager.open(openInput())).history).toBe("\uFEFFnewest\ré");
      }),
    );
  }

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "prompt \u001b[32mok\u001b[0m done\n");
    }),
  );

  it.effect("strips replayable CSI and DCS traffic while preserving setters", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      // DECRQM/DECRPM, XTVERSION, and kitty-keyboard CSI query/reply traffic.
      process.emitData("\u001b[?2026$p\u001b[?2026;2$y\u001b[>q\u001b[?u\u001b[?31u");
      // DECRQSS and XTGETTCAP query/reply traffic in 7-bit DCS form.
      process.emitData("\u001bP$q m\u001b\\\u001bP1$r0m\u001b\\");
      process.emitData("\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\");
      // The same DCS traffic in 8-bit form.
      process.emitData("\u0090$q m\u009c\u00901$r0m\u009c");
      process.emitData("\u0090+q544e\u009c\u00901+r544e=1b\u009c");
      // Setters and cursor movement share final bytes with query families but
      // have visible terminal-state value and must survive replay.
      process.emitData('\u001b[!p\u001b["p\u001b[4 q\u001b[u');
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, 'prompt \u001b[!p\u001b["p\u001b[4 q\u001b[udone\n');
    }),
  );

  it.effect("handles CSI and DCS query sequences split across output chunks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b[?2026$");
      process.emitData("pafter ");
      process.emitData("\u001bP$q ");
      process.emitData("m\u001b");
      process.emitData("\\after ");
      process.emitData("\u009b?3");
      process.emitData("1uafter ");
      process.emitData("\u0090+q544e");
      process.emitData("\u009cafter\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before after after after after\n");
    }),
  );

  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before \u001b(Bafter\n");
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(reopened.history, "before \u001b(Bafter\n");
      }),
  );

  it.effect("deletes history file when close(deleteHistory=true)", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("closes all terminals for a thread when close omits terminalId", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      const path = yield* Path.Path;
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });

      assert.equal(defaultProcess.killed, true);
      assert.equal(sidecarProcess.killed, true);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("escalates terminal shutdown to SIGKILL when process does not exit in time", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeFiber = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("publishes closed events when terminals are explicitly closed", () =>
    Effect.gen(function* () {
      const { manager, getEvents } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));

      yield* manager.close({ threadId: "thread-1" });

      const closedEvents = (yield* getEvents).filter(
        (event): event is Extract<TerminalEvent, { type: "closed" }> => event.type === "closed",
      );
      expect(closedEvents.map((event) => event.terminalId).sort()).toEqual(["default", "sidecar"]);
    }),
  );

  it.effect("evicts oldest inactive terminal sessions when retention limit is exceeded", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });

      yield* manager.open(openInput({ threadId: "thread-1" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      first.emitData("first-history\n");
      second.emitData("second-history\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir, "thread-1").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      first.emitExit({ exitCode: 0, signal: 0 });
      yield* Effect.sleep(Duration.millis(5));
      second.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "exited").length === 2,
        ),
      );

      const reopenedSecond = yield* manager.open(openInput({ threadId: "thread-2" }));
      const reopenedFirst = yield* manager.open(openInput({ threadId: "thread-1" }));

      assert.equal(reopenedFirst.history, "first-history\n");
      assert.equal(reopenedSecond.history, "");
    }),
  );

  it.effect("migrates legacy transcript filenames to terminal-scoped history path on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = yield* historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "legacy-line\n");
      expect(yield* pathExists(nextPath)).toBe(true);
      expect(yield* readFileString(nextPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );

  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const missingShell =
        platform === "win32" ? "C:\\definitely\\missing-shell.exe" : "/definitely/missing-shell -l";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe(
        platform === "win32" ? missingShell : "/definitely/missing-shell",
      );

      if (platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "powershell.exe" ||
              input.shell === "cmd.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );

  it.effect("prefers PowerShell over ComSpec for Windows terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(withHostPlatform("win32")));

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs[0]).toEqual(
        expect.objectContaining({
          shell: "pwsh.exe",
          args: ["-NoLogo"],
        }),
      );
    }),
  );

  it.effect("falls back to built-in PowerShell by absolute path on Windows", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "C:\\missing\\custom-shell.exe",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(withHostPlatform("win32")));
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
      );

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "C:\\missing\\custom-shell.exe",
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]);
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-NoLogo"]);
      expect(ptyAdapter.spawnInputs[2]?.args).toEqual(["-NoLogo"]);
    }),
  );

  it.effect.each(["linux", "darwin", "win32"] as const)(
    "advertises truecolor before the PTY backend on %s without replacing explicit values",
    (platform) =>
      Effect.gen(function* () {
        for (const [parentColor, runtimeColor, expected] of [
          [undefined, undefined, "truecolor"],
          ["", undefined, "truecolor"],
          ["24bit", undefined, "24bit"],
          ["24bit", "", "truecolor"],
          ["24bit", "custom", "custom"],
        ] as const) {
          const env = Object.freeze({ COLORTERM: parentColor });
          const { manager, ptyAdapter } = yield* createManager(5, {
            shellResolver: () => "/bin/sh",
            env,
          }).pipe(Effect.provide(withHostPlatform(platform)));
          yield* manager.open(
            openInput({ env: runtimeColor === undefined ? {} : { COLORTERM: runtimeColor } }),
          );
          expect(ptyAdapter.spawnInputs[0]?.env.COLORTERM).toBe(expected);
          expect(env.COLORTERM).toBe(parentColor);
        }
      }),
  );

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PORT: "5173",
          T3CODE_PORT: "3773",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      // Arbitrary host env vars must pass through — terminals inherit the
      // user's environment apart from the explicit blocklist.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("expands provider home paths passed to setup terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5);

      yield* manager.open({
        ...openInput(),
        env: {
          CODEX_HOME: "~/.codex-work",
          CLAUDE_CONFIG_DIR: "~/.claude-work",
          CUSTOM_ACCOUNT: "~/leave-this-value-alone",
        },
      });

      const environment = ptyAdapter.spawnInputs[0]?.env;
      expect(environment?.CODEX_HOME).toMatch(/[\\/][.]codex-work$/);
      expect(environment?.CLAUDE_CONFIG_DIR).toMatch(/[\\/][.]claude-work$/);
      expect(environment?.CUSTOM_ACCOUNT).toBe("~/leave-this-value-alone");
    }),
  );

  it.effect("strips AppImage runtime env from terminal sessions", () =>
    Effect.gen(function* () {
      const appDir = "/tmp/.mount_T3Codeabc123";
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          APPIMAGE: "/home/user/T3-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/user/T3-Code.AppImage",
          OWD: "/home/user/project",
          PATH: `${appDir}/usr/bin:${appDir}:/usr/local/bin:/usr/bin:/bin`,
          LD_LIBRARY_PATH: `${appDir}/usr/lib:/home/user/.local/lib`,
          XDG_DATA_DIRS: `${appDir}/usr/share:/usr/local/share:/usr/share`,
          GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      // AppImage runtime markers must never reach the PTY — tools inside the
      // terminal otherwise resolve against the AppImage mount (e.g. PHP_BINARY
      // reporting the AppImage path instead of the real binary).
      expect(spawnInput.env.APPIMAGE).toBeUndefined();
      expect(spawnInput.env.APPDIR).toBeUndefined();
      expect(spawnInput.env.ARGV0).toBeUndefined();
      expect(spawnInput.env.OWD).toBeUndefined();
      // PATH/LD_LIBRARY_PATH keep the user's real entries but drop the AppImage
      // mount segments that the runtime prepended.
      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      // XDG_DATA_DIRS keeps the host entries but drops the AppImage share dir.
      expect(spawnInput.env.XDG_DATA_DIRS).toBe("/usr/local/share:/usr/share");
      // GSETTINGS_SCHEMA_DIR pointed only at the mount, so it is removed and
      // gsettings falls back to the host schema location.
      expect(spawnInput.env.GSETTINGS_SCHEMA_DIR).toBeUndefined();
      // Unrelated host vars still pass through untouched.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("leaves the environment untouched when not launched from an AppImage", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LD_LIBRARY_PATH: "/home/user/.local/lib",
          // Without APPIMAGE/APPDIR set, OWD is an ordinary variable and must
          // not be stripped — only an AppImage launch gives it special meaning.
          OWD: "/home/user/keep-this",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      expect(spawnInput.env.OWD).toBe("/home/user/keep-this");
    }),
  );

  it.effect("injects runtime env overrides into spawned terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { env: { FORCE_COLOR: "3" } });
      yield* manager.open(
        openInput({
          env: {
            T3CODE_PROJECT_ROOT: "/repo",
            T3CODE_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.T3CODE_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.T3CODE_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
      assert.equal(spawnInput.env.NO_COLOR, "1");
      assert.equal(spawnInput.env.FORCE_COLOR, "0");
    }),
  );

  it.effect("resolves a provider instance environment before spawning", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { T3CODE_SECRET: "server-only" },
        resolveProviderInstanceEnvironment: (requestedId, env) =>
          Effect.succeed({
            ...env,
            PROVIDER_SECRET: requestedId === providerInstanceId ? "secret-value" : "wrong",
            CODEX_HOME: "/accounts/codex-work",
          }),
      });

      const snapshot = yield* manager.open(
        openInput({ providerInstanceId, env: { CLIENT_FLAG: "1" } }),
      );

      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("secret-value");
      expect(ptyAdapter.spawnInputs[0]?.env.CODEX_HOME).toBe("/accounts/codex-work");
      expect(ptyAdapter.spawnInputs[0]?.env.CLIENT_FLAG).toBe("1");
      expect(ptyAdapter.spawnInputs[0]?.env.T3CODE_SECRET).toBeUndefined();
      expect(snapshot).not.toHaveProperty("env");
      expect(snapshot).not.toHaveProperty("providerInstanceId");
    }),
  );

  it.effect("fails closed when a provider instance is missing", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("deleted_instance");
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          Effect.fail(
            new TerminalProviderInstanceNotFoundError({
              providerInstanceId: ProviderInstanceId.make(requestedId),
            }),
          ),
      });

      const error = yield* manager.open(openInput({ providerInstanceId })).pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("preserves the settings failure when provider environment resolution fails", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const settingsCause = new Error("secret store read failed");
      const settingsError = new ServerSettingsError({
        settingsPath: "/test/settings.json",
        operation: "read-secret",
        providerInstanceId,
        environmentVariable: "OPENROUTER_API_KEY",
        cause: settingsCause,
      });
      const serverSettings = ServerSettings.ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.fail(settingsError),
        updateSettings: () => Effect.fail(settingsError),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      });

      const error = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: providerInstanceId,
        env: undefined,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TerminalProviderEnvironmentError",
        providerInstanceId,
      });
      expect(error.cause).toBe(settingsError);
      expect(error.message).not.toContain(settingsError.message);
      expect(error.message).not.toContain("OPENROUTER_API_KEY");
    }),
  );

  it.effect.each([
    {
      name: "Codex home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex" },
      expectedHome: "/configured/codex",
    },
    {
      name: "Codex shadow home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex", shadowHomePath: "/configured/codex-shadow" },
      expectedHome: "/configured/codex-shadow",
    },
    {
      name: "Claude home",
      driver: "claudeAgent",
      variable: "CLAUDE_CONFIG_DIR",
      config: { homePath: "/configured/claude" },
      expectedHome: "/configured/claude",
    },
  ])("prefers $name over the instance environment", ({ driver, variable, config, expectedHome }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "configured_home",
        env: undefined,
      });

      expect(environment[variable]).toBe(path.resolve(expectedHome));
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("configured_home")]: {
              driver: ProviderDriverKind.make(driver),
              environment: [{ name: variable, value: "~/.environment-account", sensitive: false }],
              config,
            },
          },
        }),
      ),
    ),
  );

  it.effect("resolves the legacy Codex default instance", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex",
        env: undefined,
      });

      expect(environment.CODEX_HOME).toMatch(/[\\/][.]codex-legacy$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {},
          providers: { codex: { homePath: "~/.codex-legacy" } },
        }),
      ),
    ),
  );

  it.effect("resolves the legacy Claude default instance", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "claudeAgent",
        env: undefined,
      });

      expect(environment.CLAUDE_CONFIG_DIR).toMatch(/[\\/][.]claude-legacy$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {},
          providers: { claudeAgent: { homePath: "~/.claude-legacy" } },
        }),
      ),
    ),
  );

  it.effect("prefers an explicit default instance over legacy provider settings", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex",
        env: undefined,
      });

      expect(environment.CODEX_HOME).toMatch(/[\\/][.]codex-explicit$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providers: { codex: { homePath: "~/.codex-legacy" } },
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: "codex",
              config: { homePath: "~/.codex-explicit" },
            },
          },
        }),
      ),
    ),
  );

  it.effect("keeps unknown provider instance ids unavailable after legacy hydration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const error = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex_unknown",
        env: undefined,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TerminalProviderInstanceNotFoundError",
        providerInstanceId: "codex_unknown",
      });
    }).pipe(Effect.provide(ServerSettings.ServerSettingsService.layerTest())),
  );

  it.effect("restarts a running terminal when the resolved provider environment changes", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerSecret = "first-secret";
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: () =>
          Effect.succeed({ PROVIDER_SECRET: providerSecret }),
      });

      yield* manager.open(openInput({ providerInstanceId }));
      providerSecret = "second-secret";
      yield* manager.open(openInput({ providerInstanceId }));

      expect(ptyAdapter.processes[0]?.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env.PROVIDER_SECRET).toBe("second-secret");
    }),
  );

  it.effect("restarts with current provider secrets and clears bounded history", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_restart");
      const { manager, ptyAdapter, logsDir } = yield* createManager(2, {
        historyByteLimit: 8,
        resolveProviderInstanceEnvironment: (rawProviderInstanceId, env) =>
          TerminalManager.resolveProviderInstanceTerminalEnvironment({
            serverSettings,
            path,
            rawProviderInstanceId,
            env,
          }),
      });
      const homePath = path.join(logsDir, "codex");
      const updateSecret = (value: string) =>
        serverSettings.updateSettings({
          providerInstances: {
            [providerInstanceId]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath },
              environment: [{ name: "PROVIDER_SECRET", value, sensitive: true }],
            },
          },
        });
      const input = {
        providerInstanceId,
        env: { CLIENT_FLAG: "1", PROVIDER_SECRET: "client-value" },
      };
      const outputProcessed = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(outputProcessed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* updateSecret("first-secret");
      yield* manager.restart(restartInput(input));
      const firstProcess = ptyAdapter.processes[0]!;
      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("first-secret");
      firstProcess.emitData("discarded\nold-one\nold-two\n");
      yield* Deferred.await(outputProcessed);
      expect((yield* manager.open(openInput(input))).history).toBe("old-two\n");

      yield* updateSecret("second-secret");
      const restarted = yield* manager.restart(restartInput(input));

      expect(firstProcess.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env).toMatchObject({
        PROVIDER_SECRET: "second-secret",
        CODEX_HOME: homePath,
        CLIENT_FLAG: "1",
      });
      expect(restarted.history).toBe("");
      expect(restarted.status).toBe("running");
      expect(restarted).not.toHaveProperty("env");
      expect(restarted).not.toHaveProperty("providerInstanceId");
      const logPath = yield* historyLogPath(logsDir);
      expect(yield* readFileString(logPath)).toBe("");

      ptyAdapter.processes[1]!.emitData("discarded again\nnew-one\nnew-two\n");
      yield* manager.close({ threadId: "thread-1" });
      expect(yield* readFileString(logPath)).toBe("new-two\n");
    }).pipe(
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(SqlitePersistenceMemory),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-terminal-provider-restart-" }),
          ),
        ),
      ),
    ),
  );

  it.effect("attaches to a running provider terminal without resolving the provider again", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerAvailable = true;
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          providerAvailable
            ? Effect.succeed({ PROVIDER_SECRET: "secret-value" })
            : Effect.fail(
                new TerminalProviderInstanceNotFoundError({
                  providerInstanceId: ProviderInstanceId.make(requestedId),
                }),
              ),
      });
      yield* manager.open(openInput({ providerInstanceId }));
      providerAvailable = false;
      const events: TerminalAttachStreamEvent[] = [];

      const unsubscribe = yield* manager.attachStream(
        { ...openInput({ providerInstanceId }), restartIfNotRunning: true },
        (event) => Effect.sync(() => events.push(event)),
      );
      unsubscribe();

      expect(events[0]?.type).toBe("snapshot");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes[0]?.killed).toBe(false);
    }),
  );

  it.effect("fails closed when attaching would create a missing provider terminal", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("deleted_instance");
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          Effect.fail(
            new TerminalProviderInstanceNotFoundError({
              providerInstanceId: ProviderInstanceId.make(requestedId),
            }),
          ),
      });

      const error = yield* manager
        .attachStream(openInput({ providerInstanceId }), () => Effect.void)
        .pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("subscribes terminal metadata with an initial snapshot and live deltas", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const metadataEvents = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(metadataEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const initialEvents = yield* Ref.get(metadataEvents);
      expect(initialEvents[0]).toMatchObject({
        type: "snapshot",
        terminals: [
          {
            threadId: "existing-thread",
            terminalId: DEFAULT_TERMINAL_ID,
          },
        ],
      });

      yield* manager.open(openInput({ threadId: "new-thread" }));

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "upsert" &&
              event.terminal.threadId === "new-thread" &&
              event.terminal.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );

      yield* manager.close({ threadId: "new-thread", terminalId: DEFAULT_TERMINAL_ID });

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "remove" &&
              event.threadId === "new-thread" &&
              event.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("removes terminal metadata subscriptions when initial delivery fails", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const leakedLiveEvents = yield* Ref.make(0);
      const exit = yield* Effect.exit(
        manager.subscribeMetadata((event) =>
          event.type === "snapshot"
            ? Effect.die("snapshot listener failed")
            : Ref.update(leakedLiveEvents, (count) => count + 1),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      yield* manager.open(openInput({ threadId: "new-thread" }));
      expect(yield* Ref.get(leakedLiveEvents)).toBe(0);
    }),
  );

  it.effect(
    "streams attach snapshots followed by live events without duplicate start snapshots",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          ptyAdapter: new FakePtyAdapter("async"),
        });
        const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
        const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
          Ref.update(attachEvents, (events) => [...events, event]),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        expect(yield* Ref.get(attachEvents)).toMatchObject([
          {
            type: "snapshot",
            snapshot: {
              threadId: "thread-1",
              terminalId: DEFAULT_TERMINAL_ID,
            },
          },
        ]);

        process.emitData("hello from attach\n");

        yield* waitFor(
          Effect.map(Ref.get(attachEvents), (events) =>
            events.some((event) => event.type === "output" && event.data === "hello from attach\n"),
          ),
          "1200 millis",
        );

        const events = yield* Ref.get(attachEvents);
        expect(events.filter((event) => event.type === "snapshot")).toHaveLength(1);
      }),
  );

  it.effect("buffers attach output delivered during the initial snapshot callback", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      yield* manager.open(openInput());

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Effect.gen(function* () {
          yield* Ref.update(attachEvents, (events) => [...events, event]);
          if (event.type === "snapshot") {
            yield* Effect.sync(() => process.emitData("during snapshot\n"));
            yield* Effect.yieldNow;
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* waitFor(
        Effect.map(Ref.get(attachEvents), (events) =>
          events.some((event) => event.type === "output" && event.data === "during snapshot\n"),
        ),
        "1200 millis",
      );

      expect(yield* Ref.get(attachEvents)).toMatchObject([
        { type: "snapshot" },
        { type: "output", data: "during snapshot\n" },
      ]);
    }),
  );

  it.effect("preserves queued PTY output ordering through exit callbacks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 3;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\n", sequence: 2 }),
        expect.objectContaining({ type: "output", data: "second\n", sequence: 3 }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0, sequence: 4 }),
      ]);

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      expect(snapshot.snapshot.sequence).toBe(4);
    }),
  );

  it.effect("scoped runtime shutdown stops active terminals cleanly", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeScope = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeScope);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("reads existing output without flattening or changing the PTY", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      expect(yield* manager.readOutput({ threadId: "thread-1", terminalId: "missing" })).toBeNull();
      expect(ptyAdapter.spawnInputs).toHaveLength(0);

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const retainedText = "a".repeat(20_000) + "tail😀";
      const receipt = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(receipt, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitData(retainedText);
      yield* Deferred.await(receipt);
      unsubscribe();
      const originalValue = TerminalManager.BoundedTerminalHistory.prototype.value;
      TerminalManager.BoundedTerminalHistory.prototype.value = () => {
        throw new Error("readOutput must not flatten retained history");
      };
      try {
        const output = yield* manager.readOutput({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
        });
        expect(output).toMatchObject({
          terminalId: DEFAULT_TERMINAL_ID,
          status: "running",
          contents: "a".repeat(8_184) + "tail😀",
          retainedByteLength: Buffer.byteLength(retainedText),
          truncated: true,
        });
      } finally {
        TerminalManager.BoundedTerminalHistory.prototype.value = originalValue;
      }
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(process.resizeCalls).toHaveLength(0);
    }),
  );

  it.effect("reads running and exited retained output without restart", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const outputReceipt = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(outputReceipt, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitData("old😀");
      yield* Deferred.await(outputReceipt);
      unsubscribe();
      const running = yield* manager.readOutput({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      });
      expect(running).toMatchObject({
        status: "running",
        contents: "old😀",
        retainedByteLength: Buffer.byteLength("old😀"),
        truncated: false,
      });
      const exitedReceipt = yield* Deferred.make<void>();
      const exitUnsubscribe = yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Deferred.succeed(exitedReceipt, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitExit({ exitCode: 7, signal: 9 });
      yield* Deferred.await(exitedReceipt);
      exitUnsubscribe();
      const exited = yield* manager.readOutput({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      });
      expect(exited).toMatchObject({ status: "exited", contents: "old😀" });
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(process.resizeCalls).toHaveLength(0);
    }),
  );

  it.effect("distinguishes empty existing output from missing and reopened output", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      const beforeClearReceipt = yield* Deferred.make<void>();
      const beforeClearUnsubscribe = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(beforeClearReceipt, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      firstProcess.emitData("before-clear");
      yield* Deferred.await(beforeClearReceipt);
      beforeClearUnsubscribe();
      expect(
        yield* manager.readOutput({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID }),
      ).toMatchObject({
        contents: "before-clear",
        retainedByteLength: Buffer.byteLength("before-clear"),
        truncated: false,
      });
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      expect(
        yield* manager.readOutput({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID }),
      ).toMatchObject({
        contents: "",
        retainedByteLength: 0,
        truncated: false,
      });
      yield* manager.close({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      expect(
        yield* manager.readOutput({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID }),
      ).toBeNull();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[1];
      expect(process).toBeDefined();
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      if (!process) return;
      const receipt = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(receipt, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitData("reopened");
      yield* Deferred.await(receipt);
      unsubscribe();
      expect(
        yield* manager.readOutput({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID }),
      ).toMatchObject({
        contents: "reopened",
        status: "running",
      });
    }),
  );

  it.effect("inspects missing, running, and exited sessions without creating or resizing", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      expect(yield* manager.inspect({ threadId: "thread-1", terminalId: "missing" })).toBeNull();
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
      const snapshot = yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      const spawnCount = ptyAdapter.spawnInputs.length;
      const running = yield* manager.inspect({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      });
      expect(running).toMatchObject({
        terminalId: DEFAULT_TERMINAL_ID,
        status: "running",
        cwd: snapshot.cwd,
        worktreePath: null,
      });
      expect(ptyAdapter.spawnInputs).toHaveLength(spawnCount);
      expect(process.resizeCalls).toHaveLength(0);
      const exitedReceipt = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "exited" &&
        event.threadId === "thread-1" &&
        event.terminalId === DEFAULT_TERMINAL_ID
          ? Deferred.succeed(exitedReceipt, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitExit({ exitCode: 7, signal: 9 });
      yield* Deferred.await(exitedReceipt);
      unsubscribe();
      const exited = yield* manager.inspect({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      });
      expect(exited).toMatchObject({ status: "exited", exitCode: 7, exitSignal: 9 });
      expect(ptyAdapter.spawnInputs).toHaveLength(spawnCount);
      expect(process.resizeCalls).toHaveLength(0);
    }),
  );
});
