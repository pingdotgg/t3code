import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { EnvironmentId } from "@t3tools/contracts";
import type { ClientProviderServerFrame } from "@t3tools/contracts";
import {
  currentClientConnectionId,
  startClientProviderConnection,
  withClientConnectionId,
  withClientConnectionIdFrames,
  type ClientProviderConnection,
} from "./clientProviderConnection";
import { ClientProviderOpError, type ClientLocalProvider } from "./clientProviderTypes";

const mocks = vi.hoisted(() => ({
  providersStream: vi.fn(),
  respond: vi.fn(),
  emit: vi.fn(),
  stateChanges: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/extensions", () => ({
  environmentClientProvidersStream: mocks.providersStream,
  environmentClientProviderRespond: mocks.respond,
  environmentClientProviderEmit: mocks.emit,
  environmentConnectionStateChanges: mocks.stateChanges,
}));

vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/unstable/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});

const ENV = "env-a";

const caller = {
  installationId: "ext.a",
  contentHash: "hash-a",
  installationGeneration: 1,
};

const frameContext = {
  client: "web",
  resource: {
    namespace: "t3.extensions",
    id: "ext.a",
    environmentId: ENV,
    projectId: "project-a",
    threadId: "thread-a",
  },
} as const;

/** A plain async mailbox standing in for the server's connect stream. */
class Mailbox {
  private readonly pending: ClientProviderServerFrame[] = [];
  private readonly waiters: (() => void)[] = [];
  private closed = false;

  offer(frame: ClientProviderServerFrame) {
    this.pending.push(frame);
    this.waiters.shift()?.();
  }

  shutdown() {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  get stream(): Stream.Stream<ClientProviderServerFrame> {
    return Stream.fromAsyncIterable(this, (): never => {
      throw new Error("mailbox failed");
    });
  }

  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<ClientProviderServerFrame>> =>
        new Promise((resolve) => {
          const deliver = () => {
            const value = this.pending.shift();
            if (value !== undefined) resolve({ done: false, value });
            else if (this.closed) resolve({ done: true, value: undefined });
            else this.waiters.push(deliver);
          };
          deliver();
        }),
    };
  }
}

const invokeFrame = (
  requestId: string,
  apiId = "t3.client/theme",
  method = "getState",
): ClientProviderServerFrame =>
  ({
    type: "invoke",
    requestId,
    apiId,
    method,
    input: {},
    context: frameContext,
    caller,
    deadlineMs: 30_000,
  }) as ClientProviderServerFrame;

const connections: ClientProviderConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop();
  mocks.providersStream.mockReset();
  mocks.respond.mockReset();
  mocks.emit.mockReset();
  mocks.stateChanges.mockReset();
});

function start(options?: {
  providers?: ReadonlyMap<string, ClientLocalProvider>;
  flush?: () => Promise<void>;
  stream?: Stream.Stream<ClientProviderServerFrame>;
}) {
  mocks.respond.mockImplementation(() => Effect.succeed(null));
  mocks.emit.mockImplementation(() => Effect.succeed(null));
  mocks.stateChanges.mockReturnValue(Stream.never);
  mocks.providersStream.mockReturnValue(options?.stream ?? Stream.never);
  const connection = startClientProviderConnection({
    environmentId: EnvironmentId.make(ENV),
    providers: options?.providers ?? new Map(),
    descriptors: [{ id: "t3.client/theme", version: "1.0.0" }],
    flushGlobalCommands: options?.flush ?? (() => Promise.resolve()),
  });
  connections.push(connection);
  return connection;
}

describe("startClientProviderConnection", () => {
  it("stores the server-minted connectionId on registered and flushes staged commands", async () => {
    const queue = new Mailbox();
    const flush = vi.fn(() => Promise.resolve());
    const connection = start({
      providers: new Map(),
      flush,
      stream: queue.stream,
    });
    queue.offer({
      type: "registered",
      connectionId: "conn-1",
      accepted: [{ id: "t3.client/theme", version: "1.0.0" }],
      rejected: [],
    } as ClientProviderServerFrame);
    await vi.waitFor(() => {
      expect(currentClientConnectionId(ENV)).toBe("conn-1");
    });
    expect(flush).toHaveBeenCalledOnce();
    connection.stop();
  });

  it("answers invoke frames through respond", async () => {
    const queue = new Mailbox();
    const provider: ClientLocalProvider = {
      invoke: (call) => ({ echoed: call.method }),
    };
    start({
      providers: new Map([["t3.client/theme", provider]]),
      stream: queue.stream,
    });
    queue.offer(invokeFrame("req-1"));
    await vi.waitFor(() => {
      expect(mocks.respond).toHaveBeenCalledWith(ENV, {
        requestId: "req-1",
        ok: true,
        value: { echoed: "getState" },
      });
    });
  });

  it("reports missing providers and provider errors as ok:false", async () => {
    const queue = new Mailbox();
    const failing: ClientLocalProvider = {
      invoke: () => {
        throw new ClientProviderOpError("custom-code", "nope");
      },
    };
    const crashing: ClientLocalProvider = {
      invoke: () => {
        throw new Error("boom");
      },
    };
    start({
      providers: new Map([
        ["t3.client/failing", failing],
        ["t3.client/crashing", crashing],
      ]),
      stream: queue.stream,
    });
    queue.offer(invokeFrame("req-unknown", "t3.client/ghost"));
    queue.offer(invokeFrame("req-coded", "t3.client/failing"));
    queue.offer(invokeFrame("req-crash", "t3.client/crashing"));
    await vi.waitFor(() => {
      expect(mocks.respond).toHaveBeenCalledTimes(3);
    });
    const byId = new Map(mocks.respond.mock.calls.map((call) => [call[1].requestId, call[1]]));
    expect(byId.get("req-unknown")).toMatchObject({
      ok: false,
      error: { code: "client-provider-unavailable" },
    });
    expect(byId.get("req-coded")).toMatchObject({
      ok: false,
      error: { code: "custom-code", message: "nope" },
    });
    expect(byId.get("req-crash")).toMatchObject({
      ok: false,
      error: { code: "provider-rejected", message: "boom" },
    });
  });

  it("aborts a pending invoke when a cancel frame arrives", async () => {
    const queue = new Mailbox();
    let observedSignal: AbortSignal | null = null;
    const provider: ClientLocalProvider = {
      invoke: (call) => {
        observedSignal = call.signal;
        return new Promise(() => {});
      },
    };
    start({
      providers: new Map([["t3.client/theme", provider]]),
      stream: queue.stream,
    });
    queue.offer(invokeFrame("req-cancel"));
    await vi.waitFor(() => {
      expect(observedSignal).not.toBeNull();
    });
    queue.offer({ type: "cancel", requestId: "req-cancel" } as ClientProviderServerFrame);
    await vi.waitFor(() => {
      expect(observedSignal!.aborted).toBe(true);
    });
  });

  it("wires subscriptions to provider streams and forwards events", async () => {
    const queue = new Mailbox();
    const closed = vi.fn();
    const provider: ClientLocalProvider = {
      invoke: () => ({}),
      openStream: (call) => {
        call.emit({ type: "snapshot", value: { ready: true } });
        return closed;
      },
    };
    start({
      providers: new Map([["t3.client/theme", provider]]),
      stream: queue.stream,
    });
    queue.offer({
      type: "subscriptionOpen",
      subscriptionId: "sub-1",
      apiId: "t3.client/theme",
      name: "watchState",
      input: {},
      context: frameContext,
      caller,
    } as ClientProviderServerFrame);
    await vi.waitFor(() => {
      expect(mocks.emit).toHaveBeenCalledWith(ENV, {
        correlationId: "sub-1",
        event: { type: "snapshot", value: { ready: true } },
      });
    });
    queue.offer({
      type: "subscriptionClose",
      subscriptionId: "sub-1",
    } as ClientProviderServerFrame);
    await vi.waitFor(() => {
      expect(closed).toHaveBeenCalledOnce();
    });
  });

  it("emits closed immediately for providers without a stream", async () => {
    const queue = new Mailbox();
    start({
      providers: new Map([["t3.client/theme", { invoke: () => ({}) }]]),
      stream: queue.stream,
    });
    queue.offer({
      type: "subscriptionOpen",
      subscriptionId: "sub-2",
      apiId: "t3.client/theme",
      name: "watchState",
      input: {},
      context: frameContext,
      caller,
    } as ClientProviderServerFrame);
    await vi.waitFor(() => {
      expect(mocks.emit).toHaveBeenCalledWith(ENV, {
        correlationId: "sub-2",
        event: { type: "closed", value: null },
      });
    });
  });

  it("closes live subscriptions and drops the connectionId when the stream ends", async () => {
    const queue = new Mailbox();
    const closed = vi.fn();
    const provider: ClientLocalProvider = {
      invoke: () => ({}),
      openStream: () => closed,
    };
    start({
      providers: new Map([["t3.client/theme", provider]]),
      stream: queue.stream,
    });
    queue.offer({
      type: "registered",
      connectionId: "conn-2",
      accepted: [],
      rejected: [],
    } as ClientProviderServerFrame);
    queue.offer({
      type: "subscriptionOpen",
      subscriptionId: "sub-3",
      apiId: "t3.client/theme",
      name: "watchState",
      input: {},
      context: frameContext,
      caller,
    } as ClientProviderServerFrame);
    await vi.waitFor(() => {
      expect(currentClientConnectionId(ENV)).toBe("conn-2");
    });
    queue.shutdown();
    await vi.waitFor(() => {
      expect(closed).toHaveBeenCalledOnce();
      expect(currentClientConnectionId(ENV)).toBeUndefined();
    });
  });

  it("stops dispatching frames after stop()", async () => {
    const queue = new Mailbox();
    const provider: ClientLocalProvider = { invoke: vi.fn(() => ({})) };
    const connection = start({
      providers: new Map([["t3.client/theme", provider]]),
      stream: queue.stream,
    });
    connection.stop();
    // One more frame lets the loop observe the abort and exit.
    queue.offer(invokeFrame("req-late"));
    queue.shutdown();
    await vi.waitFor(
      () => {
        expect(provider.invoke).not.toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
  });
});

it("stop tears down an idle registered stream", async () => {
  const queue = new Mailbox();
  const connection = start({ stream: queue.stream });
  queue.offer({
    type: "registered",
    connectionId: "review-conn",
    accepted: [],
    rejected: [],
  } as ClientProviderServerFrame);
  await vi.waitFor(() => expect(currentClientConnectionId(ENV)).toBe("review-conn"));
  connection.stop();
  try {
    // Teardown is synchronous — no further frame is needed to drop the id.
    await vi.waitFor(() => expect(currentClientConnectionId(ENV)).toBeUndefined(), {
      timeout: 150,
      interval: 10,
    });
  } finally {
    queue.shutdown();
  }
});

it("a synchronous subscription failure leaves the seam alive", async () => {
  const queue = new Mailbox();
  const invoke = vi.fn(() => null);
  start({
    stream: queue.stream,
    providers: new Map([
      [
        "t3.client/theme",
        {
          invoke,
          openStream() {
            throw new ClientProviderOpError("client-target-denied", "stale installation");
          },
        },
      ],
    ]),
  });
  queue.offer({
    type: "registered",
    connectionId: "review-sub",
    accepted: [],
    rejected: [],
  } as ClientProviderServerFrame);
  await vi.waitFor(() => expect(currentClientConnectionId(ENV)).toBe("review-sub"));
  queue.offer({
    type: "subscriptionOpen",
    subscriptionId: "sub-fail",
    apiId: "t3.client/theme",
    name: "watchState",
    input: {},
    caller,
    context: frameContext,
  } as ClientProviderServerFrame);
  // The failed open must not take unrelated invokes down with it.
  queue.offer(invokeFrame("after-failed-sub"));
  try {
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce(), {
      timeout: 150,
      interval: 10,
    });
  } finally {
    queue.shutdown();
  }
});

describe("connection replacement and clean EOF", () => {
  it("a stale stop cannot delete a replacement connection with the same socket id", async () => {
    const first = new Mailbox();
    const second = new Mailbox();
    const a = start({ stream: first.stream });
    first.offer({
      type: "registered",
      connectionId: "same-socket",
      accepted: [],
      rejected: [],
    } as ClientProviderServerFrame);
    await vi.waitFor(() => expect(currentClientConnectionId(ENV)).toBe("same-socket"));
    const flush = vi.fn(() => Promise.resolve());
    start({ stream: second.stream, flush });
    second.offer({
      type: "registered",
      connectionId: "same-socket",
      accepted: [],
      rejected: [],
    } as ClientProviderServerFrame);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    a.stop();
    try {
      expect(currentClientConnectionId(ENV)).toBe("same-socket");
    } finally {
      first.shutdown();
      second.shutdown();
    }
  });

  it("normal stream completion reconnects on a live transport", async () => {
    const first = new Mailbox();
    start({ stream: first.stream });
    first.offer({
      type: "registered",
      connectionId: "old-socket",
      accepted: [],
      rejected: [],
    } as ClientProviderServerFrame);
    await vi.waitFor(() => expect(currentClientConnectionId(ENV)).toBe("old-socket"));
    mocks.stateChanges.mockReturnValue(Stream.make({ phase: "connected" }));
    first.shutdown();
    await vi.waitFor(() => expect(mocks.providersStream.mock.calls.length).toBeGreaterThan(1), {
      timeout: 1500,
    });
  });
});

describe("client connection hint on early calls", () => {
  // The shape the web client sees when the server rejects an unhinted
  // client-targeted call: a request error wrapping the operation error.
  const targetRequired = () =>
    Object.assign(
      new Error(
        "Failed to fetch remote environment endpoint /api/extensions/api/invoke (ExtensionOperationError: client-target-required: The call needs the client's own connection hint.)",
      ),
      {
        cause: {
          _tag: "ExtensionOperationError",
          detail: "client-target-required: The call needs the client's own connection hint.",
        },
      },
    );
  const registered = {
    type: "registered",
    connectionId: "conn-early",
    accepted: [{ id: "t3.client/theme", version: "1.0.0" }],
    rejected: [],
  } as ClientProviderServerFrame;

  it("holds a call made before the seam registers and sends it once, stamped", async () => {
    const queue = new Mailbox();
    start({ stream: queue.stream });
    const hints: (string | undefined)[] = [];
    const result = withClientConnectionId(ENV, new AbortController().signal, async (hint) => {
      hints.push(hint);
      if (hint === undefined) throw targetRequired();
      return { theme: "dark" };
    });
    await Promise.resolve();
    expect(hints).toEqual([]);
    queue.offer(registered);
    await expect(result).resolves.toEqual({ theme: "dark" });
    expect(hints).toEqual(["conn-early"]);
  });

  it("runs a write whose nested client call needs the hint exactly once", async () => {
    // An installed provider appends a record, then its nested client call
    // fails without the hint; the outer write must never be replayed.
    const queue = new Mailbox();
    start({ stream: queue.stream });
    let writes = 0;
    const hints: (string | undefined)[] = [];
    const result = withClientConnectionId(ENV, new AbortController().signal, async (hint) => {
      hints.push(hint);
      writes += 1;
      if (hint === undefined) throw targetRequired();
      return { appended: writes };
    });
    await Promise.resolve();
    queue.offer(registered);
    await result.catch(() => {});
    expect(writes).toBe(1);
    expect(hints).toEqual(["conn-early"]);
  });

  it("does not resend failures", async () => {
    const queue = new Mailbox();
    start({ stream: queue.stream });
    queue.offer(registered);
    await vi.waitFor(() => expect(currentClientConnectionId(ENV)).toBe("conn-early"));
    const send = vi.fn(async () => {
      throw new Error("client-target-denied: Missing grant t3.ui/read");
    });
    await expect(withClientConnectionId(ENV, new AbortController().signal, send)).rejects.toThrow(
      "client-target-denied",
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("sends at once, unstamped, when no seam is starting", async () => {
    const send = vi.fn(async (hint: string | undefined) => hint);
    await expect(withClientConnectionId(ENV, new AbortController().signal, send)).resolves.toBe(
      undefined,
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("holds a call made before the transport is up until the reconnect registers", async () => {
    // A restored panel calls before the environment's first session exists:
    // that connect fails, and the call must wait for the next one.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const queue = new Mailbox();
      mocks.providersStream.mockReturnValueOnce(Stream.fail(new Error("no session")));
      start({ stream: queue.stream });
      mocks.stateChanges.mockReturnValue(Stream.make({ phase: "connected" }));
      const hints: (string | undefined)[] = [];
      const result = withClientConnectionId(ENV, new AbortController().signal, async (hint) => {
        hints.push(hint);
        if (hint === undefined) throw targetRequired();
        return { theme: "dark" };
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(hints).toEqual([]);
      queue.offer(registered);
      await expect(result).resolves.toEqual({ theme: "dark" });
      expect(hints).toEqual(["conn-early"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the held call and later ones at once when the server lacks the seam", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      start({ stream: Stream.die("Unknown request tag: extensions.clientProviders.connect") });
      mocks.stateChanges.mockReturnValue(Stream.make({ phase: "connected" }));
      const send = vi.fn(async (hint: string | undefined) => hint);
      const held = withClientConnectionId(ENV, new AbortController().signal, send);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledOnce();
      await expect(held).resolves.toBe(undefined);
      // Later calls, including across the loop's retry, leave at once too.
      await vi.advanceTimersByTimeAsync(1000);
      const later = withClientConnectionId(ENV, new AbortController().signal, send);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(2);
      await expect(later).resolves.toBe(undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds calls again after a drop, since the next connection may reach an upgraded server", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const queue = new Mailbox();
      const states = new Mailbox();
      mocks.providersStream.mockReturnValueOnce(
        Stream.die("Unknown request tag: extensions.clientProviders.connect"),
      );
      start({ stream: queue.stream });
      mocks.stateChanges.mockReturnValue(states.stream);
      const hints: (string | undefined)[] = [];
      const send = async (hint: string | undefined) => {
        hints.push(hint);
        return hint;
      };
      await vi.advanceTimersByTimeAsync(0);
      await expect(withClientConnectionId(ENV, new AbortController().signal, send)).resolves.toBe(
        undefined,
      );
      await vi.advanceTimersByTimeAsync(1000);
      states.offer({ phase: "connected" } as never);
      states.offer({ phase: "reconnecting" } as never);
      await vi.advanceTimersByTimeAsync(0);
      const afterDrop = withClientConnectionId(ENV, new AbortController().signal, send);
      await vi.advanceTimersByTimeAsync(0);
      expect(hints).toEqual([undefined]);
      states.offer({ phase: "connected" } as never);
      await vi.advanceTimersByTimeAsync(0);
      queue.offer(registered);
      await expect(afterDrop).resolves.toBe("conn-early");
      expect(hints).toEqual([undefined, "conn-early"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a held call unstamped after the bound, and never on abort", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      start({ stream: new Mailbox().stream });
      const send = vi.fn(async (hint: string | undefined) => hint);
      const late = withClientConnectionId(ENV, new AbortController().signal, send);
      const controller = new AbortController();
      const aborted = withClientConnectionId(ENV, controller.signal, send);
      controller.abort();
      await expect(aborted).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(late).resolves.toBe(undefined);
      expect(send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a stream started before the seam registers once, stamped", async () => {
    const queue = new Mailbox();
    start({ stream: queue.stream });
    const hints: (string | undefined)[] = [];
    const frames = withClientConnectionIdFrames(ENV, new AbortController().signal, (hint) => {
      hints.push(hint);
      return (async function* () {
        if (hint === undefined) throw targetRequired();
        yield { type: "snapshot", value: { wordWrap: false } };
      })();
    });
    const first = frames.next();
    await Promise.resolve();
    expect(hints).toEqual([]);
    queue.offer(registered);
    await expect(first).resolves.toEqual({
      done: false,
      value: { type: "snapshot", value: { wordWrap: false } },
    });
    expect(hints).toEqual(["conn-early"]);
    await frames.return();
  });
});
