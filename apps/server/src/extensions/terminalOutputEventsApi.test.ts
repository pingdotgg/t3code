import {
  AuthTerminalOperateScope,
  ProjectId,
  ThreadId,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it } from "@effect/vitest";
import { createTerminalOutputEventsApiProvider } from "./terminalOutputEventsApi.ts";
import type { HostApiInvocationMetadata } from "@t3tools/extension-runtime";
import type { TerminalOutputObservationEvent } from "../terminal/Manager.ts";

const context = {
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision("/workspace", null),
} as const;
const metadata: HostApiInvocationMetadata = {
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
const snapshot: TerminalOutputObservationEvent = {
  type: "snapshot",
  sourceEpoch: "epoch-1",
  threadId: "thread",
  terminalId: "term-1",
  sequence: 0,
  clearGeneration: 0,
  contentsUnitStart: 0,
  snapshot: {
    threadId: "thread",
    terminalId: "term-1",
    cwd: "/workspace",
    worktreePath: null,
    status: "running",
    contents: "initial",
    retainedByteLength: 7,
    truncated: false,
  },
};
function output(sequence: number, data = `line-${sequence}`): TerminalOutputObservationEvent {
  return {
    type: "output",
    sourceEpoch: "epoch-1",
    threadId: "thread",
    terminalId: "term-1",
    sequence,
    data,
  };
}
function fixture(
  options: {
    readonly onSubscribe?: (
      listener: (event: TerminalOutputObservationEvent) => void,
    ) => Effect.Effect<void>;
  } = {},
) {
  let listener: ((event: TerminalOutputObservationEvent) => void) | undefined;
  let unsubscribed = false;
  let signalReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const provider = createTerminalOutputEventsApiProvider({
    environmentId: "env",
    projects: {
      getById: (input: { projectId: ProjectId }) =>
        Effect.succeed(
          Option.some({ projectId: input.projectId, workspaceRoot: "/workspace", deletedAt: null }),
        ),
    },
    threads: {
      getById: (_input: { threadId: ThreadId }) =>
        Effect.succeed(
          Option.some({
            projectId: ProjectId.make("project"),
            worktreePath: null,
            deletedAt: null,
          }),
        ),
    },
    terminal: {
      subscribeOutput: (_input, callback) => {
        listener = callback;
        signalReady();
        const acquired = options.onSubscribe
          ? options.onSubscribe(callback)
          : Effect.sync(() => callback(snapshot));
        return acquired.pipe(
          Effect.map(() => () => {
            unsubscribed = true;
          }),
        );
      },
    },
  });
  return {
    provider,
    emit: (event: TerminalOutputObservationEvent) => listener?.(event),
    ready,
    unsubscribed: () => unsubscribed,
  };
}

async function iteratorOf(fixtureValue: ReturnType<typeof fixture>) {
  const stream = fixtureValue.provider.subscribe!(
    "subscribe",
    { terminalId: "term-1" },
    context,
    new AbortController().signal,
    metadata,
  );
  const iterator = stream[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: "snapshot" });
  return iterator;
}

it("carries retained-window provenance on snapshot and reset frames", async () => {
  const f = fixture({
    onSubscribe: (callback) =>
      Effect.sync(() =>
        callback({
          ...snapshot,
          clearGeneration: 1,
          contentsUnitStart: 42,
        }),
      ),
  });
  const stream = f.provider.subscribe!(
    "subscribe",
    { terminalId: "term-1" },
    context,
    new AbortController().signal,
    metadata,
  );
  const iterator = stream[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({
    type: "snapshot",
    value: { clearGeneration: 1, contentsUnitStart: 42 },
  });
  f.emit({
    type: "cleared",
    sourceEpoch: "epoch-1",
    threadId: "thread",
    terminalId: "term-1",
    sequence: 7,
    clearGeneration: 2,
  });
  expect((await iterator.next()).value).toMatchObject({
    type: "reset",
    value: { kind: "reset", clearGeneration: 2 },
  });
});

it("releases native queue groups after consumption", async () => {
  const f = fixture();
  const iterator = await iteratorOf(f);
  for (let sequence = 1; sequence <= 12; sequence += 1) {
    f.emit(output(sequence));
    const next = await iterator.next();
    expect(next.value).toMatchObject({ type: "data", value: { sequence } });
  }
  await iterator.return!();
  expect(f.unsubscribed()).toBe(true);
});

it("terminates visibly at eight pending native events and cleans up", async () => {
  const f = fixture();
  const iterator = await iteratorOf(f);
  for (let sequence = 1; sequence <= 9; sequence += 1) f.emit(output(sequence));
  const next = await iterator.next();
  expect(next.value).toMatchObject({
    type: "closed",
    value: { kind: "closed", reason: "overflow" },
  });
  expect(f.unsubscribed()).toBe(true);
});

it("keeps the initial snapshot first when overflow occurs before its consumption", async () => {
  const f = fixture();
  const stream = f.provider.subscribe!(
    "subscribe",
    { terminalId: "term-1" },
    context,
    new AbortController().signal,
    metadata,
  );
  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();
  await f.ready;
  for (let sequence = 1; sequence <= 9; sequence += 1) f.emit(output(sequence));
  expect((await first).value).toMatchObject({ type: "snapshot" });
  expect((await iterator.next()).value).toMatchObject({
    type: "closed",
    value: { reason: "overflow" },
  });
  expect(f.unsubscribed()).toBe(true);
});

it("keeps escaped NUL chunks within the encoded frame bound", async () => {
  const f = fixture();
  const iterator = await iteratorOf(f);
  f.emit(output(1, "\0".repeat(8_192)));
  const next = await iterator.next();
  const value = next.value?.value as { chunkCount: number; data: string };
  expect(next.value).toMatchObject({ type: "data", value: { chunkIndex: 0, chunkCount: 1 } });
  expect(value.data).toHaveLength(8_192);
  expect(
    Buffer.byteLength(
      JSON.stringify({
        streamId: "x".repeat(128),
        sequence: Number.MAX_SAFE_INTEGER,
        type: "data",
        value: next.value?.value,
      }),
      "utf8",
    ),
  ).toBeLessThanOrEqual(64 * 1024);
});

it("closes cleanly when public conversion rejects a native event", async () => {
  const f = fixture();
  const iterator = await iteratorOf(f);
  const malformed = output(1);
  Object.defineProperty(malformed, "data", {
    get: () => {
      throw new Error("native callback conversion failed");
    },
  });
  f.emit(malformed);
  const next = await iterator.next();
  expect(next.value).toMatchObject({
    type: "closed",
    value: { kind: "closed", reason: "terminal-error" },
  });
  expect(f.unsubscribed()).toBe(true);
});

it("preserves a queued snapshot before callback failure", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    onSubscribe: (callback) =>
      Effect.sync(() => callback(snapshot)).pipe(Effect.andThen(Effect.promise(() => gate))),
  });
  const stream = f.provider.subscribe!(
    "subscribe",
    { terminalId: "term-1" },
    context,
    new AbortController().signal,
    metadata,
  );
  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();
  await f.ready;
  const malformed = output(1);
  Object.defineProperty(malformed, "data", {
    get: () => {
      throw new Error("conversion failed");
    },
  });
  f.emit(malformed);
  release();
  expect((await first).value).toMatchObject({ type: "snapshot" });
  expect((await iterator.next()).value).toMatchObject({
    type: "closed",
    value: { kind: "closed", reason: "terminal-error" },
  });
  expect(f.unsubscribed()).toBe(true);
});

it("completes after an exited initial snapshot", async () => {
  const f = fixture({
    onSubscribe: (callback) =>
      Effect.sync(() =>
        callback({
          ...snapshot,
          snapshot: { ...snapshot.snapshot, status: "exited" },
        }),
      ),
  });
  const iterator = f.provider.subscribe!(
    "subscribe",
    { terminalId: "term-1" },
    context,
    new AbortController().signal,
    metadata,
  )[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({
    type: "snapshot",
    value: { status: "exited" },
  });
  expect(await iterator.next()).toMatchObject({ done: true });
  expect(f.unsubscribed()).toBe(true);
});

it("cancels pending native acquisition and waits for its cleanup", async () => {
  let acquired!: () => void;
  let released!: () => void;
  const acquiredPromise = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const releasedPromise = new Promise<void>((resolve) => {
    released = resolve;
  });
  const f = fixture({
    onSubscribe: () =>
      Effect.acquireUseRelease(
        Effect.sync(acquired),
        () => Effect.never,
        () => Effect.sync(released),
      ),
  });
  const controller = new AbortController();
  const iterator = f.provider.subscribe!(
    "subscribe",
    { terminalId: "term-1" },
    context,
    controller.signal,
    metadata,
  )[Symbol.asyncIterator]();
  const pending = iterator.next();
  await acquiredPromise;
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  await releasedPromise;
  expect(f.unsubscribed()).toBe(false);
});

it("return cancels pending native acquisition", async () => {
  let acquired!: () => void;
  let released!: () => void;
  const acquiredPromise = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const releasedPromise = new Promise<void>((resolve) => {
    released = resolve;
  });
  const f = fixture({
    onSubscribe: () =>
      Effect.acquireUseRelease(
        Effect.sync(acquired),
        () => Effect.never,
        () => Effect.sync(released),
      ),
  });
  const iterator = f.provider.subscribe!(
    "subscribe",
    { terminalId: "term-1" },
    context,
    new AbortController().signal,
    metadata,
  )[Symbol.asyncIterator]();
  const pending = iterator.next();
  await acquiredPromise;
  await iterator.return!();
  await expect(pending).rejects.toBeDefined();
  await releasedPromise;
});

it("checks native snapshot workspace before exposing it", async () => {
  const f = fixture({
    onSubscribe: (callback) =>
      Effect.sync(() =>
        callback({
          ...snapshot,
          snapshot: { ...snapshot.snapshot, cwd: "/other" },
        }),
      ),
  });
  const iterator = f.provider.subscribe!(
    "subscribe",
    { terminalId: "term-1" },
    context,
    new AbortController().signal,
    metadata,
  )[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toThrow("requested workspace");
  expect(f.unsubscribed()).toBe(true);
});

it("rejects cursor and root authority before native acquisition", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  expect(() =>
    f.provider.subscribe!(
      "subscribe",
      { terminalId: "term-1" },
      context,
      signal,
      metadata,
      "cursor-1",
    ),
  ).toThrow("resume");
  const { principal: _principal, ...withoutRoot } = metadata;
  expect(() =>
    f.provider.subscribe!("subscribe", { terminalId: "term-1" }, context, signal, withoutRoot),
  ).toThrow("authority");
  expect(f.ready).toBeInstanceOf(Promise);
});
