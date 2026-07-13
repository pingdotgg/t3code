import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import * as React from "react";

import type { OrchestrationShellSnapshot, OrchestrationThread, TuiClient } from "../connection.ts";
import { ChatView } from "./ChatView.tsx";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const project = {
  id: "p1",
  title: "Project one",
  workspaceRoot: "/workspace/project-one",
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

function thread(activities: OrchestrationThread["activities"] = []): OrchestrationThread {
  return {
    id: "t1",
    projectId: "p1",
    title: "Thread one",
    interactionMode: "default",
    runtimeMode: "full-access",
    worktreePath: null,
    updatedAt: "2026-07-13T00:00:00.000Z",
    session: { status: "idle" },
    latestTurn: null,
    messages: [],
    activities,
    checkpoints: [],
    proposedPlans: [],
    hasMoreActivities: false,
  } as unknown as OrchestrationThread;
}

function shell(
  threads: OrchestrationShellSnapshot["threads"] = [
    {
      id: "t1",
      projectId: "p1",
      title: "Thread one",
      updatedAt: "2026-07-13T00:00:00.000Z",
      session: { status: "idle" },
    },
  ] as unknown as OrchestrationShellSnapshot["threads"],
): OrchestrationShellSnapshot {
  return {
    projects: [project],
    threads,
  } as unknown as OrchestrationShellSnapshot;
}

function fakeClient({
  detail,
  shellSnapshot = shell(),
  sendReply = () => Promise.resolve(),
  respondUserInput = () => Promise.resolve(),
}: {
  readonly detail: OrchestrationThread;
  readonly shellSnapshot?: OrchestrationShellSnapshot;
  readonly sendReply?: TuiClient["sendReply"];
  readonly respondUserInput?: TuiClient["respondUserInput"];
}): {
  readonly client: TuiClient;
  readonly connect: () => void;
  readonly subscribedThreadIds: string[];
} {
  let shellSubscriber: ((snapshot: OrchestrationShellSnapshot) => void) | null = null;
  const subscribedThreadIds: string[] = [];
  const client = {
    subscribeShell: (onSnapshot: (snapshot: OrchestrationShellSnapshot) => void) => {
      shellSubscriber = onSnapshot;
      return () => {
        shellSubscriber = null;
      };
    },
    subscribeThread: (threadId: string) => {
      subscribedThreadIds.push(threadId);
      return () => {};
    },
    peekThread: () => detail,
    subscribeVcsStatus: () => () => {},
    subscribeTerminalMetadata: () => () => {},
    sendReply,
    respondUserInput,
    getThreadActivities: async () => ({ activities: [], hasMore: false }),
    getAttachmentUrl: async () => null,
    getAttachmentImage: async () => null,
    runGitStackedAction: async () => {},
    runGitPull: async () => {},
  } as unknown as TuiClient;
  return { client, connect: () => shellSubscriber?.(shellSnapshot), subscribedThreadIds };
}

async function selectThread(
  setup: Awaited<ReturnType<typeof testRender>>,
  connect: () => void,
): Promise<void> {
  await React.act(async () => {
    await setup.renderOnce();
    connect();
    await setup.renderOnce();
    await setup.flush();
  });
  await setup.waitForFrame((frame) => frame.includes("Project one"));

  // The initial selection is the collapsed project. Empty Enter expands it;
  // Alt+Down then selects the first thread and attaches its live detail.
  await React.act(async () => {
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey("\x1b\x1b[B");
    await setup.renderOnce();
  });
  await setup.waitForFrame(
    (frame) => frame.includes("Thread one") && !frame.includes("Enter to expand"),
  );
}

describe("ChatView tmux scrolling", () => {
  it("Given an image is visible, when tmux delivers a scroll fallback as an arrow key, then the selected thread does not change", async () => {
    const detail = {
      ...thread(),
      messages: [
        {
          id: "u1",
          role: "user",
          text: "image under review",
          createdAt: "2026-07-13T00:00:00.000Z",
          updatedAt: "2026-07-13T00:00:00.000Z",
          streaming: false,
          attachments: [
            {
              type: "image",
              id: "att1",
              name: "diagram.png",
              mimeType: "image/png",
              sizeBytes: 1024,
            },
          ],
        },
      ],
    } as unknown as OrchestrationThread;
    const fake = fakeClient({
      detail,
      shellSnapshot: shell([
        {
          id: "t1",
          projectId: "p1",
          title: "Thread one",
          updatedAt: "2026-07-13T00:00:01.000Z",
          session: { status: "idle" },
        },
        {
          id: "t2",
          projectId: "p1",
          title: "Thread two",
          updatedAt: "2026-07-13T00:00:00.000Z",
          session: { status: "idle" },
        },
      ] as unknown as OrchestrationShellSnapshot["threads"]),
    });
    const setup = await testRender(<ChatView client={fake.client} onExit={() => {}} />, {
      width: 110,
      height: 28,
    });

    await selectThread(setup, fake.connect);
    await setup.waitForFrame((frame) => frame.includes("diagram.png"));
    expect(fake.subscribedThreadIds.at(-1)).toBe("t1");

    await React.act(async () => {
      setup.mockInput.pressArrow("down");
      await setup.renderOnce();
    });

    expect(fake.subscribedThreadIds).toEqual(["t1"]);
    setup.renderer.destroy();
  });
});

describe("ChatView acknowledged submissions", () => {
  it("Given a reply is in flight, when Enter repeats and the request fails, then one request is made and the exact draft remains", async () => {
    const request = deferred<void>();
    const calls: Array<{ readonly text: string }> = [];
    const fake = fakeClient({
      detail: thread(),
      sendReply: async (_detail, text) => {
        calls.push({ text });
        return request.promise;
      },
    });
    const setup = await testRender(<ChatView client={fake.client} onExit={() => {}} />, {
      width: 110,
      height: 28,
    });

    await selectThread(setup, fake.connect);
    await React.act(async () => {
      await setup.mockInput.typeText("keep this exact draft");
      await setup.renderOnce();
    });
    await setup.waitForFrame((frame) => frame.includes("keep this exact draft"));
    await React.act(async () => {
      setup.mockInput.pressEnter();
      setup.mockInput.pressEnter();
      await setup.renderOnce();
    });
    await setup.waitFor(() => calls.length > 0);

    expect(calls).toEqual([{ text: "keep this exact draft" }]);
    await React.act(async () => {
      request.reject(new Error("offline"));
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((next) => next.includes("send failed"));
    expect(frame).toContain("keep this exact draft");
    setup.renderer.destroy();
  });

  it("Given a reply is accepted, when acknowledgement arrives, then the draft clears only after success", async () => {
    const request = deferred<void>();
    const fake = fakeClient({
      detail: thread(),
      sendReply: () => request.promise,
    });
    const setup = await testRender(<ChatView client={fake.client} onExit={() => {}} />, {
      width: 110,
      height: 28,
    });

    await selectThread(setup, fake.connect);
    await React.act(async () => {
      await setup.mockInput.typeText("ship after ack");
      await setup.renderOnce();
    });
    await setup.waitForFrame((frame) => frame.includes("ship after ack"));
    await React.act(async () => {
      setup.mockInput.pressEnter();
      await setup.renderOnce();
    });
    const pendingFrame = await setup.waitForFrame((next) => next.includes("Sending"));
    expect(pendingFrame).toContain("ship after ack");

    await React.act(async () => {
      request.resolve();
      await Promise.resolve();
    });
    const successFrame = await setup.waitForFrame(
      (next) => next.includes("✓ Reply") && !next.includes("ship after ack"),
    );
    expect(successFrame).not.toContain("ship after ack");
    setup.renderer.destroy();
  });

  it("Given a custom user-input answer is in flight, when Enter repeats and the request fails, then one response is made and the answer remains", async () => {
    const request = deferred<void>();
    const answers: Array<Record<string, string | string[]>> = [];
    const pendingActivity = {
      id: "activity-1",
      kind: "user-input.requested",
      createdAt: "2026-07-13T00:00:00.000Z",
      turnId: null,
      summary: "Input requested",
      tone: "info",
      payload: {
        requestId: "request-1",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope?",
            options: [{ label: "Everything", description: "" }],
            multiSelect: false,
          },
        ],
      },
    } as unknown as OrchestrationThread["activities"][number];
    const fake = fakeClient({
      detail: thread([pendingActivity]),
      respondUserInput: async (_threadId, _requestId, nextAnswers) => {
        answers.push(nextAnswers);
        return request.promise;
      },
    });
    const setup = await testRender(<ChatView client={fake.client} onExit={() => {}} />, {
      width: 110,
      height: 28,
    });

    await selectThread(setup, fake.connect);
    await setup.waitForFrame((frame) => frame.includes("Which scope?"));
    await React.act(async () => {
      await setup.mockInput.typeText("Only the terminal UI");
      await setup.renderOnce();
    });
    await setup.waitForFrame((frame) => frame.includes("Only the terminal UI"));
    await React.act(async () => {
      setup.mockInput.pressEnter();
      setup.mockInput.pressEnter();
      await setup.renderOnce();
    });
    await setup.waitFor(() => answers.length > 0);

    expect(answers).toEqual([{ scope: "Only the terminal UI" }]);
    await React.act(async () => {
      request.reject(new Error("disconnected"));
      await Promise.resolve();
    });
    const frame = await setup.waitForFrame((next) => next.includes("answer failed"));
    expect(frame).toContain("Only the terminal UI");
    setup.renderer.destroy();
  });
});
