import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, VoiceSessionId } from "@t3tools/contracts";
import { createCommandSession, resolveDirectCommand } from "./command-session";
import { allowsThreadCreation } from "./command-policy";
import type { VoiceLiveClient, VoiceLiveClientEvent, VoiceLiveClientOptions } from "./live-client";

const thread = {
  id: ThreadId.make("thread-september"),
  environmentId: EnvironmentId.make("local"),
  title: "Onboarding plan September",
};
const answer = (text: string) => ({
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const events = new Set<(event: VoiceLiveClientEvent) => void>();
  const spoken = deferred<string>();
  const acknowledged = deferred<void>();
  const acknowledgeAction = vi.fn(() => acknowledged.resolve());
  const steer = vi.fn((text: string) => {
    spoken.resolve(text);
    return true;
  });
  const respond = vi.fn(async (_input: unknown) => answer("Which plan did you mean?"));
  const execute = vi.fn(async (_name: string, _input: unknown): Promise<unknown> => ({
    acknowledged: true,
  }));
  const openDraft = vi.fn(async () => ({ draftId: "draft-one", threadId: "future-thread" }));
  let factoryOptions: VoiceLiveClientOptions | undefined;
  const base: VoiceLiveClient = {
    start: async () => ({ sessionId: VoiceSessionId.make("session") }),
    close: async () => undefined,
    onEvent(listener) {
      events.add(listener);
      return () => events.delete(listener);
    },
    getState: () => "live",
    getSessionId: () => VoiceSessionId.make("session"),
    emitMark: () => undefined,
    steer,
  };
  const client = createCommandSession(
    {
      acknowledgeAction,
      broker: {
        respond,
        mintSession: async () => ({ sessionId: VoiceSessionId.make("session"), sdp: "sdp" }),
        closeSession: async () => ({ closed: true }),
      },
      createPeerConnection: () => {
        throw new Error("unused");
      },
      executor: { execute },
    },
    { threads: () => [thread], openDraft, context: () => "current project oracle" },
    (options) => {
      factoryOptions = options;
      return base;
    },
  );
  return {
    client,
    respond,
    execute,
    openDraft,
    spoken,
    acknowledged,
    acknowledgeAction,
    steer,
    factoryOptions,
    emit: (event: VoiceLiveClientEvent) => {
      for (const listener of events) listener(event);
    },
  };
}

describe("experimental command session", () => {
  it("requires an explicit creation request rather than an update or negated creation", () => {
    for (const text of [
      "Ask that thread for an update",
      "Open the thread called New thread",
      "Don't create a new thread, update the existing one",
      "Start working on that thread",
      "Get an update from the planning thread",
    ]) {
      expect(allowsThreadCreation(text)).toBe(false);
    }
    for (const text of [
      "Start a thread in Oracle to investigate this",
      "Make me a new thread",
      "Create a new thread for an update dashboard",
      "Open a new thread",
    ]) {
      expect(allowsThreadCreation(text)).toBe(true);
    }
  });
  it("refuses a model's attempt to create a thread for an update, then continues the existing thread", async () => {
    const h = setup();
    h.respond.mockResolvedValueOnce({
      status: "completed",
      output: [
        { type: "function_call", name: "voice.startThread", arguments: "{}", call_id: "wrong" },
      ],
    } as never);
    h.respond.mockResolvedValueOnce({
      status: "completed",
      output: [
        {
          type: "function_call",
          name: "voice.continueThread",
          arguments: JSON.stringify({
            threadId: thread.id,
            environmentId: thread.environmentId,
            task: "Give me an update",
          }),
          call_id: "followup",
        },
      ],
    } as never);
    h.client.sendText?.("Ask that thread for an update");
    await h.spoken.promise;
    expect(h.execute).toHaveBeenCalledExactlyOnceWith("voice.continueThread", {
      threadId: thread.id,
      environmentId: thread.environmentId,
      task: "Give me an update",
    });
    expect(JSON.stringify(h.respond.mock.calls[1])).toContain("No explicit new-thread request");
    expect(h.openDraft).not.toHaveBeenCalled();
  });

  it("labels the current thread as discussed context, not the destination of new work", async () => {
    const h = setup();
    h.client.sendText?.("Find my onboarding work");
    await h.spoken.promise;
    // The wrong-project failure started here: the backend read the current
    // thread's project as the destination for a new thread. The context
    // message must name that distinction on every delegated request.
    const developerMessage = JSON.stringify(h.respond.mock.calls[0]);
    expect(developerMessage).toContain("reference data only");
    expect(developerMessage).toContain("not the default destination for new work");
  });

  it("chimes for model-selected navigation and suppresses its verbose confirmation", async () => {
    const h = setup();
    h.respond.mockResolvedValueOnce({
      status: "completed",
      output: [
        { type: "function_call", name: "voice.openThread", arguments: "{}", call_id: "open" },
      ],
    } as never);
    h.respond.mockResolvedValueOnce(answer("I have opened the very long thread title for you."));
    const finished = deferred<void>();
    h.client.onEvent((event) => {
      if (event.type === "command_result") finished.resolve();
    });
    h.client.sendText?.("Open October instead");
    await finished.promise;
    expect(h.acknowledgeAction).toHaveBeenCalledOnce();
    expect(h.steer).not.toHaveBeenCalled();
  });

  it("uses the direct path for a unique title and stores its identity for a contextual follow-up", async () => {
    const h = setup();
    h.client.sendText?.("Open the thread called Onboarding plan September.");
    await h.acknowledged.promise;
    expect(h.steer).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledExactlyOnceWith("openThread", {
      environmentId: thread.environmentId,
      threadId: thread.id,
    });
    expect(h.respond).not.toHaveBeenCalled();
    h.client.sendText?.("What happened in that thread?");
    // The request begins synchronously, before its awaited backend result.
    expect(h.respond).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.respond.mock.calls[0])).toContain(thread.id);
  });

  it("keeps negation, corrections, duplicates and compound tasks out of the direct resolver", () => {
    for (const text of [
      "Do not open the thread called Onboarding plan September",
      "Open the thread called Onboarding plan September actually October",
      "Open the thread called Onboarding plan September and summarize it",
      "Open the thread about onboarding",
    ]) {
      expect(resolveDirectCommand(text, [thread])).toBeNull();
    }
    expect(
      resolveDirectCommand("Open the thread called Onboarding plan September", [
        thread,
        { ...thread, id: ThreadId.make("other") },
      ]),
    ).toBeNull();
  });

  it("opens a draft without asking a model or claiming a worker started", async () => {
    const h = setup();
    h.client.sendText?.("Make me a new thread");
    await h.acknowledged.promise;
    expect(h.steer).not.toHaveBeenCalled();
    expect(h.openDraft).toHaveBeenCalledOnce();
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("does not act on a partial transcript and handles each delegation identity once", async () => {
    const h = setup();
    h.emit({
      type: "transcript",
      channel: "input",
      delta: "Open the thread called Onboarding plan September",
      utterance: "in-1",
    });
    expect(h.execute).not.toHaveBeenCalled();
    h.emit({ type: "delegation", id: "delegation-1" });
    await h.acknowledged.promise;
    h.emit({ type: "delegation", id: "delegation-1" });
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it("continues a real tool protocol through the fallback without dropping call identities", async () => {
    const h = setup();
    h.respond.mockResolvedValueOnce({
      status: "completed",
      output: [
        {
          type: "function_call",
          name: "searchThreads",
          arguments: '{"query":"onboarding"}',
          call_id: "call-1",
        },
      ],
    } as never);
    h.client.sendText?.("Find my onboarding work");
    expect(await h.spoken.promise).toBe("Which plan did you mean?");
    expect(h.execute).toHaveBeenCalledExactlyOnceWith("searchThreads", { query: "onboarding" });
    expect(JSON.stringify(h.respond.mock.calls[1])).toContain('"call_id":"call-1"');
  });

  it("does not execute late backend work after closing", async () => {
    const h = setup();
    const pending = deferred<ReturnType<typeof answer>>();
    h.respond.mockReturnValueOnce(pending.promise);
    h.client.sendText?.("Find the plan");
    await h.client.close();
    pending.resolve({
      status: "completed",
      output: [{ type: "function_call", name: "openThread", arguments: "{}", call_id: "late" }],
    } as never);
    await pending.promise;
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.client.sendText?.("Make me a new thread")).toBe(false);
  });

  it("lets a newer direct command supersede an old model response", async () => {
    const h = setup();
    const pending = deferred<ReturnType<typeof answer>>();
    h.respond.mockReturnValueOnce(pending.promise);
    h.client.sendText?.("Find the plan");
    h.client.sendText?.("Make me a new thread");
    await h.acknowledged.promise;
    pending.resolve({
      status: "completed",
      output: [{ type: "function_call", name: "openThread", arguments: "{}", call_id: "late" }],
    } as never);
    await pending.promise;
    expect(h.openDraft).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("reports failed navigation instead of a false success", async () => {
    const h = setup();
    h.execute.mockResolvedValueOnce({ acknowledged: false });
    h.client.sendText?.("Open the thread called Onboarding plan September");
    expect(await h.spoken.promise).toContain("could not be completed");
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.acknowledgeAction).not.toHaveBeenCalled();
  });
});
