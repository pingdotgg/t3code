/**
 * Deterministic openThread loop: composes the real live client, command
 * session, tool bridge, and navigator over injected boundaries (route driver,
 * tools, broker, clock) and captures an ordered timeline of steps and timing
 * marks. Gates are deferreds resolved by the test; no sleeps, no wall-clock
 * assumptions. The logical clock advances one tick per read, so mark deltas
 * count synchronous/microtask hops, not milliseconds.
 */
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, VoiceSessionId } from "@t3tools/contracts";

import {
  createVoiceLiveClient,
  type VoiceLiveClientEvent,
  type VoiceLiveRtcDataChannel,
  type VoiceLiveRtcPeerConnection,
  type VoiceLiveSessionDescription,
} from "./live-client";
import { createCommandSession, type CommandActions } from "./command-session";
import { createVoiceNavigator, type VoiceRouteDriver } from "./navigation";
import { createNavigatingVoiceToolExecutor } from "./ui/toolBridge";
import type { VoiceToolExecutor } from "./tools";

// ---------------------------------------------------------------------------
// Injected boundaries
// ---------------------------------------------------------------------------

class FakeDataChannel implements VoiceLiveRtcDataChannel {
  readonly sent: Array<string> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: { readonly message?: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  receive(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

class FakePeerConnection implements VoiceLiveRtcPeerConnection {
  readonly channel = new FakeDataChannel();
  closed = false;
  connectionState = "new";
  ontrack: VoiceLiveRtcPeerConnection["ontrack"] = null;
  onconnectionstatechange: (() => void) | null = null;

  createDataChannel(): VoiceLiveRtcDataChannel {
    return this.channel;
  }
  async createOffer(): Promise<VoiceLiveSessionDescription> {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  addTrack(): void {}
  close(): void {
    this.closed = true;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ENV = EnvironmentId.make("env-1");
const THREAD_ONE = ThreadId.make("thread-1");
const THREAD_TWO = ThreadId.make("thread-2");

interface LoopHarness {
  readonly timeline: string[];
  readonly marks: Array<{ mark: string; detail?: string }>;
  readonly chimes: number;
  readonly commandResults: string[];
  readonly errors: Array<{ code: string; message: string }>;
  readonly lateRedirects: Array<{ code: string; threadId?: string }>;
  readonly navigations: Array<{ threadId: string; replace: boolean | undefined }>;
  readonly pendingNavigations: Array<() => void>;
  readonly pathListeners: Array<(path: string) => void>;
  readonly sent: FakeDataChannel;
  readonly toolCalls: Array<{ tool: string; threadId?: string }>;
  readonly respondCalls: number;
  setPath(path: string): void;
  armNextToolGate(tool: string): void;
  releaseToolGates(tool: string): void;
  respondRelease(index: number, value: unknown): void;
  sendText(text: string): boolean;
  readonly client: ReturnType<typeof createVoiceLiveClient>;
}

const makeLoop = (): LoopHarness => {
  const timeline: string[] = [];
  let ticks = 0;
  const now = () => ticks;
  const step = (label: string) => {
    ticks += 1;
    timeline.push(`${ticks}:${label}`);
  };

  // Route driver: navigations park on a deferred the test resolves.
  const pathState = { current: "/" };
  const pendingNavigations: Array<() => void> = [];
  const navigations: Array<{ threadId: string; replace: boolean | undefined }> = [];
  const pathListeners: Array<(path: string) => void> = [];
  const driver: VoiceRouteDriver = {
    navigate: async ({ params, replace }) => {
      navigations.push({ threadId: params.threadId, replace });
      step(`navigate:${params.threadId}`);
      await new Promise<void>((resolve) => {
        pendingNavigations.push(() => {
          step(`navigateResolved:${params.threadId}`);
          resolve();
        });
      });
    },
    readCurrentPath: () => {
      step(`readPath:${pathState.current}`);
      return pathState.current;
    },
    subscribePathChange: (listener) => {
      pathListeners.push(listener);
      return () => {
        const index = pathListeners.indexOf(listener);
        if (index >= 0) pathListeners.splice(index, 1);
      };
    },
  };

  // Tools: openThread/searchThreads park on per-tool gates when armed; every
  // other tool resolves immediately.
  const toolCalls: Array<{ tool: string; threadId?: string }> = [];
  const gates: Record<"openThread" | "searchThreads", Array<Deferred<void>>> = {
    openThread: [],
    searchThreads: [],
  };
  const armed: Record<string, boolean> = { openThread: false, searchThreads: false };
  const tools = {
    openThread: async (input: { environmentId: string; threadId: string }) => {
      toolCalls.push({ tool: "openThread", threadId: input.threadId });
      step(`tools.openThread:${input.threadId}`);
      if (armed.openThread) {
        const gate = deferred<void>();
        gates.openThread.push(gate);
        await gate.promise;
      }
      step(`tools.openThreadValidated:${input.threadId}`);
      return {
        environment: { environmentId: input.environmentId, status: "ok" },
        acknowledged: false,
        destination: { environmentId: input.environmentId, threadId: input.threadId },
      };
    },
    searchThreads: async (input: { query: string }) => {
      toolCalls.push({ tool: "searchThreads" });
      step(`tools.searchThreads:${input.query}`);
      if (armed.searchThreads) {
        const gate = deferred<void>();
        gates.searchThreads.push(gate);
        await gate.promise;
      }
      step("tools.searchThreadsValidated");
      return {
        perEnvironment: [
          {
            environment: { environmentId: ENV, status: "ok" },
            matches: [
              {
                threadId: THREAD_TWO,
                projectId: "project-1",
                threadTitle: "Project Factory Icon Concepts",
                source: "title",
                termCoverage: 1,
              },
            ],
          },
        ],
      };
    },
  } as unknown as VoiceToolExecutor;

  const marks: Array<{ mark: string; detail?: string }> = [];
  const lateRedirects: Array<{ code: string; threadId?: string }> = [];
  const navigator = createVoiceNavigator({
    driver,
    reachabilityOf: () => "connected",
    emitMark: (mark, detail) => {
      step(`mark:${mark}${detail === undefined ? "" : `(${detail})`}`);
      marks.push({ mark, ...(detail === undefined ? {} : { detail }) });
    },
    onRedirectAfterAcknowledgment: (error) => {
      step(`lateRedirect:${error.code}`);
      lateRedirects.push({
        code: error.code,
        ...(error.threadId === undefined ? {} : { threadId: error.threadId }),
      });
    },
    redirectWatchMs: 30_000,
  });
  const bridge = createNavigatingVoiceToolExecutor({ tools, navigator });

  // Broker: each respond call parks on a scripted release.
  const respondReleases: Array<(value: unknown) => void> = [];
  let respondCalls = 0;
  const respond = async (): Promise<{
    status: string;
    output: ReadonlyArray<unknown>;
  }> => {
    respondCalls += 1;
    const mine = respondCalls;
    step(`respond#${mine}`);
    return await new Promise<{ status: string; output: ReadonlyArray<unknown> }>((resolve) => {
      respondReleases.push((value) => {
        step(`respondResolved#${mine}`);
        resolve(value as { status: string; output: ReadonlyArray<unknown> });
      });
    });
  };

  const peerConnection = new FakePeerConnection();
  let chimes = 0;
  const commandResults: string[] = [];
  const errors: Array<{ code: string; message: string }> = [];

  const actions: CommandActions = {
    threads: () => [
      { environmentId: ENV, id: THREAD_ONE, title: "Onboarding plan September" },
      { environmentId: ENV, id: THREAD_TWO, title: "Project Factory Icon Concepts" },
    ],
    openDraft: async () => null,
    context: () => "ctx",
  };

  const client = createCommandSession(
    {
      acknowledgeAction: () => {
        chimes += 1;
        step("chime");
      },
      broker: {
        respond,
        mintSession: async () => ({ sessionId: VoiceSessionId.make("live_sess_1"), sdp: "sdp" }),
        closeSession: async () => ({ closed: true }),
      },
      createPeerConnection: () => peerConnection,
      executor: bridge,
      now,
    },
    actions,
    (options) => createVoiceLiveClient(options),
  );

  client.onEvent((event: VoiceLiveClientEvent) => {
    if (event.type === "command_result") {
      step(`command_result:${event.text}`);
      commandResults.push(event.text);
    } else if (event.type === "error") {
      step(`error:${event.error.code}`);
      errors.push(event.error);
    } else if (event.type === "timing") {
      step(`mark:${event.record.mark}(${event.record.detail ?? ""})`);
      marks.push({
        mark: event.record.mark,
        ...(event.record.detail === undefined ? {} : { detail: event.record.detail }),
      });
    }
  });

  return {
    timeline,
    marks,
    get chimes() {
      return chimes;
    },
    commandResults,
    errors,
    lateRedirects,
    navigations,
    pendingNavigations,
    pathListeners,
    sent: peerConnection.channel,
    toolCalls,
    get respondCalls() {
      return respondCalls;
    },
    setPath: (path: string) => {
      pathState.current = path;
    },
    armNextToolGate: (tool: "openThread" | "searchThreads") => {
      armed[tool] = true;
    },
    releaseToolGates: (tool: "openThread" | "searchThreads") => {
      armed[tool] = false;
      for (const gate of gates[tool] ?? []) gate.resolve();
      gates[tool] = [];
    },
    respondRelease: (index: number, value: unknown) => {
      respondReleases[index]?.(value);
    },
    sendText: (text: string) => client.sendText?.(text) ?? false,
    client,
  };
};

const startToLive = async (h: LoopHarness) => {
  const started = h.client.start();
  await flush();
  h.sent.receive({ type: "session.started" });
  await started;
};

const functionCall = (name: string, callId: string, args: unknown) => ({
  status: "completed",
  output: [
    {
      type: "function_call",
      name: `voice.${name}`,
      arguments: JSON.stringify(args),
      call_id: callId,
    },
  ],
});

const finalAnswer = (text: string) => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
});

// ---------------------------------------------------------------------------
// The measured loop
// ---------------------------------------------------------------------------

describe("openThread deterministic loop", () => {
  it("exact-title direct path: one chime, no backend round trip, acknowledgment after route read-back", async () => {
    const h = makeLoop();
    await startToLive(h);

    h.sendText("Open the thread called Project Factory Icon Concepts.");
    await flush();
    h.setPath(`/${ENV}/${THREAD_TWO}`);
    h.pendingNavigations[0]?.();
    await flush();

    expect(h.respondCalls).toBe(0);
    expect(h.chimes).toBe(1);
    expect(h.commandResults).toEqual(["Project Factory Icon Concepts is open."]);
    expect(h.errors).toEqual([]);
    expect(h.marks.map((m) => m.mark)).toEqual(["navigation_acknowledged"]);
    expect(h.navigations).toEqual([{ threadId: THREAD_TWO, replace: true }]);
    // The full ordered timeline, captured (not assumed): validation, route
    // navigation, read-back, acknowledgment, then the local confirmation.
    expect(h.timeline).toEqual([
      "1:tools.openThread:thread-2",
      "2:tools.openThreadValidated:thread-2",
      "3:navigate:thread-2",
      "4:navigateResolved:thread-2",
      "5:readPath:/env-1/thread-2",
      "6:mark:navigation_acknowledged(env-1/thread-2)",
      "7:command_result:Project Factory Icon Concepts is open.",
      "8:chime",
    ]);
  });

  it("backend path: two respond round trips before the route lands, a third before confirmation; one chime", async () => {
    const h = makeLoop();
    await startToLive(h);
    h.armNextToolGate("openThread");

    h.sendText("Where is my project factory icon work?");
    await flush();
    h.respondRelease(0, functionCall("searchThreads", "s1", { query: "icon" }));
    await flush();
    h.respondRelease(
      1,
      functionCall("openThread", "o1", { environmentId: ENV, threadId: THREAD_TWO }),
    );
    await flush();
    h.releaseToolGates("openThread");
    await flush();
    h.setPath(`/${ENV}/${THREAD_TWO}`);
    h.pendingNavigations[0]?.();
    await flush();
    h.respondRelease(2, finalAnswer("I have opened Project Factory Icon Concepts."));
    await flush();

    expect(h.respondCalls).toBe(3);
    expect(h.commandResults).toEqual(["I have opened Project Factory Icon Concepts."]);
    // Measured: the client-delegation respond loop runs tools in the command
    // session, so the live client's data-channel function-loop marks never
    // fire here; the only mark is the navigator's acknowledgment.
    expect(h.marks.map((m) => m.mark)).toEqual(["navigation_acknowledged"]);
    // Measured: exactly one chime (the command session's; the live client's
    // function loop is not involved on this transport).
    expect(h.chimes).toBe(1);
    // The ordered loop, captured end to end: two full backend round trips
    // and both tool validations happen before the route even lands, and the
    // confirmation text waits for a third round trip.
    expect(h.timeline).toEqual([
      "1:respond#1",
      "2:respondResolved#1",
      "3:tools.searchThreads:icon",
      "4:tools.searchThreadsValidated",
      "5:respond#2",
      "6:respondResolved#2",
      "7:tools.openThread:thread-2",
      "8:tools.openThreadValidated:thread-2",
      "9:navigate:thread-2",
      "10:navigateResolved:thread-2",
      "11:readPath:/env-1/thread-2",
      "12:mark:navigation_acknowledged(env-1/thread-2)",
      "13:chime",
      "14:respond#3",
      "15:respondResolved#3",
      "16:command_result:I have opened Project Factory Icon Concepts.",
    ]);
  });

  it("correction while the first open is in flight: the second open waits for the whole first open", async () => {
    const h = makeLoop();
    await startToLive(h);
    h.armNextToolGate("openThread");

    h.sendText("Open the thread called Onboarding plan September");
    await flush();
    expect(h.toolCalls).toEqual([{ tool: "openThread", threadId: THREAD_ONE }]);

    // The user corrects mid-open. The correction's tool call must not start
    // until the first open's validation AND navigation fully complete,
    // because the session serializes executor actions.
    h.sendText("Open the thread called Project Factory Icon Concepts");
    await flush();
    expect(h.toolCalls).toHaveLength(1);

    h.releaseToolGates("openThread");
    await flush();
    expect(h.toolCalls).toHaveLength(1);
    h.setPath(`/${ENV}/${THREAD_ONE}`);
    h.pendingNavigations[0]?.();
    await flush();

    // Only now does the correction begin.
    expect(h.toolCalls).toEqual([
      { tool: "openThread", threadId: THREAD_ONE },
      { tool: "openThread", threadId: THREAD_TWO },
    ]);
    h.setPath(`/${ENV}/${THREAD_TWO}`);
    h.pendingNavigations[1]?.();
    await flush();

    // The stale first open lands transiently, but only the correction
    // confirms: one chime, one command_result, both for thread-2.
    expect(h.chimes).toBe(1);
    expect(h.commandResults).toEqual(["Project Factory Icon Concepts is open."]);
    expect(h.navigations.map((n) => n.threadId)).toEqual([THREAD_ONE, THREAD_TWO]);
  });

  it("late-redirect watch reads any path change to / as the missing-thread guard, including a user Home click", async () => {
    const h = makeLoop();
    await startToLive(h);

    h.sendText("Open the thread called Project Factory Icon Concepts.");
    await flush();
    h.setPath(`/${ENV}/${THREAD_TWO}`);
    h.pendingNavigations[0]?.();
    await flush();

    expect(h.chimes).toBe(1);
    expect(h.lateRedirects).toEqual([]);

    // The user clicks Home (_chat.index resolves to "/") inside the watch
    // window. The navigator cannot tell this from the missing-thread guard's
    // automatic redirect and reports the acknowledged open as failed.
    h.pathListeners[0]?.("/");
    await flush();

    expect(h.lateRedirects).toEqual([{ code: "thread_not_found", threadId: THREAD_TWO }]);
  });
});
