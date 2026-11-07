import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { watchProviderSignInLink } from "./providerSignInLink";

const link =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=test-state";

function authState(overrides: Partial<ProviderAuthState>): ProviderAuthState {
  return {
    instanceId: ProviderInstanceId.make("antigravity"),
    phase: "starting",
    flowId: "flow-1",
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    ...overrides,
  } as ProviderAuthState;
}

describe("watchProviderSignInLink", () => {
  let registry: AtomRegistry.AtomRegistry;
  let atom: Atom.Writable<AsyncResult.AsyncResult<ProviderAuthState, unknown>>;
  let opened: string[];
  let ended: number;

  const watch = (timeoutMs?: number) =>
    watchProviderSignInLink({
      registry,
      atom,
      flowId: "flow-1",
      open: (url) => opened.push(url),
      onEnd: () => {
        ended += 1;
      },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  const publish = (state: ProviderAuthState) => registry.set(atom, AsyncResult.success(state));

  beforeEach(() => {
    vi.useFakeTimers();
    registry = AtomRegistry.make();
    atom = Atom.make<AsyncResult.AsyncResult<ProviderAuthState, unknown>>(
      AsyncResult.initial(false),
    ).pipe(Atom.keepAlive);
    opened = [];
    ended = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the link once it arrives for its own flow", () => {
    publish(authState({ phase: "idle", flowId: null }));
    watch();
    publish(authState({}));
    expect(opened).toEqual([]);

    publish(authState({ phase: "waiting", authorizationUrl: link }));
    publish(authState({ phase: "waiting", authorizationUrl: link }));
    expect(opened).toEqual([link]);
    expect(ended).toBe(0);
  });

  it("opens a link that is already shown", () => {
    publish(authState({ phase: "waiting", authorizationUrl: link }));
    watch();
    expect(opened).toEqual([link]);
  });

  it("ignores another flow's link", () => {
    watch();
    publish(authState({ phase: "waiting", flowId: "flow-2", authorizationUrl: link }));
    expect(opened).toEqual([]);
  });

  it("reports the end when its flow ends without a link", () => {
    watch();
    publish(authState({ phase: "cancelled" }));
    publish(authState({ phase: "waiting", authorizationUrl: link }));
    expect(opened).toEqual([]);
    expect(ended).toBe(1);
  });

  it("reports the end when its flow disappears after it was seen", () => {
    watch();
    publish(authState({}));
    publish(authState({ phase: "idle", flowId: null }));
    publish(authState({ phase: "waiting", authorizationUrl: link }));
    expect(opened).toEqual([]);
    expect(ended).toBe(1);
  });

  it("keeps a throwing callback out of the shared subscription", () => {
    watchProviderSignInLink({
      registry,
      atom,
      flowId: "flow-1",
      open: () => {
        throw new Error("open failed");
      },
    });
    expect(() => publish(authState({ phase: "waiting", authorizationUrl: link }))).not.toThrow();
  });

  it("keeps the server subscription open after settings unmounts", async () => {
    let closed = false;
    const listeners = new Set<(state: ProviderAuthState) => void>();
    const emit = (state: ProviderAuthState) => {
      for (const listener of listeners) listener(state);
    };
    // Like providerAuthState: a pushed subscription that closes as soon as nothing reads it.
    const server = Atom.make((get): AsyncResult.AsyncResult<ProviderAuthState, unknown> => {
      const listener = (state: ProviderAuthState) => get.setSelf(AsyncResult.success(state));
      listeners.add(listener);
      get.addFinalizer(() => {
        closed = true;
        listeners.delete(listener);
      });
      return AsyncResult.initial(false);
    }).pipe(Atom.setIdleTTL(0));
    const unmountSettings = registry.mount(server);
    emit(authState({}));
    watchProviderSignInLink({
      registry,
      atom: server,
      flowId: "flow-1",
      open: (url) => opened.push(url),
    });

    unmountSettings();
    await vi.advanceTimersByTimeAsync(100);
    expect(closed).toBe(false);

    emit(authState({ phase: "waiting", authorizationUrl: link }));
    expect(opened).toEqual([link]);
    await vi.advanceTimersByTimeAsync(100);
    expect(closed).toBe(true);
  });

  it("reports a timeout as the end, but not an early stop", () => {
    watch(1_000);
    vi.advanceTimersByTime(1_000);
    publish(authState({ phase: "waiting", authorizationUrl: link }));
    expect(ended).toBe(1);

    publish(authState({}));
    const stop = watch();
    stop();
    publish(authState({ phase: "waiting", authorizationUrl: link }));
    expect(opened).toEqual([]);
    expect(ended).toBe(1);
  });
});
