// Ada's computer-use helper child, driven over its frame channel.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { createChild } from "./child.ts";
import type { ChildMessage, ChildRequest, ChildTransport, Mac } from "./child.ts";
import type { Answers } from "./decisions.ts";
import { FakeControls, FakeNotes } from "./fake.ts";
import type { Logger } from "./log.ts";

const decision = (choice: string, probability = 0.9) => ({
  type: "choice" as const,
  choice,
  probability,
});

/** A logger the test reads: what the helper records is how the test sees a run that ends without a frame. */
function recorder() {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const write =
    (event: string) =>
    (_kind: string, fields: Record<string, unknown> = {}) => {
      events.push({ event, fields });
    };
  const log: Logger = { info: write("info"), warn: write("warn"), error: write("error") };
  return { log, events };
}

/** The child's machine: the fake Notes app in front, and fixed controls that record what they were asked. */
function machine(): Mac {
  return {
    desktop: new FakeNotes(),
    tabs: null,
    dock: null,
    apps: null,
    controls: new FakeControls(),
    urls: { open: async () => "Safari" },
  };
}

/**
 * The parent's end: frames come up, the server's answers go down. `answer` is asked for a reply to each `decide` and
 * `authorize` frame, and `until` waits for a frame that has arrived.
 */
function channel(answer?: (message: ChildMessage) => ChildRequest | null) {
  const sent: ChildMessage[] = [];
  const listeners: Array<(chunk: string) => void> = [];
  const closes: Array<() => void> = [];
  const waiters: Array<() => void> = [];
  const down = (frame: ChildRequest) => {
    for (const listener of listeners) listener(`${JSON.stringify(frame)}\n`);
  };
  const transport: ChildTransport = {
    send(frame) {
      const message = JSON.parse(frame) as ChildMessage;
      sent.push(message);
      const reply = answer?.(message);
      if (reply) queueMicrotask(() => down(reply));
      for (const waiter of waiters.splice(0)) waiter();
    },
    receive(handler) {
      listeners.push(handler);
    },
    onClose(handler) {
      closes.push(handler);
    },
  };
  const until = async (test: (message: ChildMessage) => boolean) => {
    for (;;) {
      const found = sent.find(test);
      if (found) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { transport, sent, down, until, close: () => closes.forEach((close) => close()) };
}

/** Answers every grant with a grant, and every decision from the script. */
const scripted =
  (replies: Answers[]) =>
  (message: ChildMessage): ChildRequest | null => {
    if (message.kind === "authorize")
      return { id: message.id, kind: "grant", grant: { ok: true, grant: "allow" } };
    if (message.kind !== "decide") return null;
    const answers = replies.shift();
    if (!answers) throw new Error("no answer scripted");
    return { id: message.id, kind: "answers", answers };
  };

describe("the helper child", () => {
  it("runs a task the server decides and grants, and reports each step as it happens", async () => {
    const replies: Answers[] = [
      { surface: decision("current") },
      { next: decision("type_text"), type_into: decision("c0") },
      { next: decision("done") },
    ];
    const parent = channel(scripted(replies));
    createChild({ transport: parent.transport, mac: machine, log: recorder().log });
    parent.down({
      id: "task_1",
      kind: "start",
      task: { goal: "search my notes for groceries", text: "groceries" },
    });
    const finished = await parent.until((message) => message.kind === "finished");
    expect(finished).toMatchObject({ id: "task_1", taskId: "task_1" });
    expect(finished.kind === "finished" ? finished.outcome : null).toMatchObject({
      status: "done",
    });
    // The steps the server was told, and the exact action it was asked to grant.
    expect(
      parent.sent
        .filter((message) => message.kind === "step")
        .map((message) => (message.kind === "step" ? message.text : "")),
    ).toEqual(["worked in the app in front", "typed the text into the textbox “Search”"]);
    const typed = parent.sent.find(
      (message) => message.kind === "authorize" && message.request.action.kind === "type",
    );
    expect(typed).toMatchObject({
      taskId: "task_1",
      request: {
        step: 1,
        action: { kind: "type", role: "textbox", label: "Search", text: "groceries" },
      },
    });
  });

  it("reads a window on a look frame without a task, and reports how an act reached the app", async () => {
    const parent = channel((message) =>
      message.kind === "authorize"
        ? { id: message.id, kind: "grant", grant: { ok: true, grant: "allow" } }
        : null,
    );
    createChild({ transport: parent.transport, mac: machine, log: recorder().log });
    parent.down({ id: "look_1", kind: "look" });
    const look = await parent.until((message) => message.kind === "look");
    expect(look).toMatchObject({ id: "look_1", look: { app: "Notes", text: "3 notes" } });
    expect(look.kind === "look" ? look.look.controls[0] : null).toEqual({
      ref: "search",
      role: "textbox",
      label: "Search",
      value: "",
    });

    parent.down({
      id: "act_1",
      kind: "start",
      task: { goal: "click Delete", text: null, act: { action: "click", ref: "delete" } },
    });
    await parent.until((message) => message.kind === "finished");
    expect(parent.sent.find((message) => message.kind === "acted")).toMatchObject({
      taskId: "act_1",
      action: "click",
      mode: "background",
    });

    // An open_url act asks for its grant before its first await: the grant must still name the task.
    parent.down({
      id: "act_2",
      kind: "start",
      task: {
        goal: "open https://example.com",
        text: null,
        act: { action: "open_url", url: "https://example.com" },
      },
    });
    expect(
      await parent.until(
        (message) => message.kind === "authorize" && message.request.action.kind === "open_url",
      ),
    ).toMatchObject({ taskId: "act_2" });
  });

  it("refuses a second task while one runs, and reports what is running", async () => {
    const parent = channel((message) =>
      message.kind === "authorize"
        ? { id: message.id, kind: "grant", grant: { ok: true, grant: "allow" } }
        : null,
    );
    createChild({ transport: parent.transport, mac: machine, log: recorder().log });
    parent.down({
      id: "task_1",
      kind: "start",
      task: { goal: "search my notes for groceries", text: "groceries" },
    });
    // The first task waits for a decision this parent never answers.
    await parent.until((message) => message.kind === "decide");
    parent.down({ id: "task_2", kind: "start", task: { goal: "another task", text: null } });
    expect(await parent.until((message) => message.id === "task_2")).toMatchObject({
      kind: "error",
      error: "busy",
    });
    parent.down({ id: "status_1", kind: "status" });
    expect(await parent.until((message) => message.id === "status_1")).toEqual({
      id: "status_1",
      kind: "current",
      current: { id: "task_1", goal: "search my notes for groceries" },
    });
  });

  it("ends the running task when its parent disconnects", async () => {
    const parent = channel();
    const recorded = recorder();
    const child = createChild({ transport: parent.transport, mac: machine, log: recorded.log });
    parent.down({
      id: "task_1",
      kind: "start",
      task: { goal: "search my notes for groceries", text: "groceries" },
    });
    const waiting = await parent.until((message) => message.kind === "decide");
    expect(waiting).toMatchObject({ taskId: "task_1" });
    parent.close();
    await child.done;
    // The run ended as stopped, and nothing was written to a channel that is gone.
    expect(
      recorded.events.find((entry) => entry.event === "info" && entry.fields.status === "stopped"),
    ).toMatchObject({ fields: { status: "stopped" } });
    expect(parent.sent.some((message) => message.kind === "finished")).toBe(false);
    // Nothing more is asked of a server that is gone.
    parent.down({ id: "task_2", kind: "start", task: { goal: "another task", text: null } });
    expect(parent.sent.some((message) => message.id === "task_2")).toBe(false);
  });

  it("stops the task on a stop frame, and runs a fixed control", async () => {
    const parent = channel();
    const child = createChild({ transport: parent.transport, mac: machine, log: recorder().log });
    parent.down({
      id: "task_1",
      kind: "start",
      task: { goal: "search my notes for groceries", text: "groceries" },
    });
    await parent.until((message) => message.kind === "decide");
    parent.down({ id: "stop_1", kind: "stop", reason: "You stopped it." });
    const finished = await parent.until((message) => message.kind === "finished");
    expect(finished.kind === "finished" ? finished.outcome : null).toMatchObject({
      status: "stopped",
      reason: "You stopped it.",
    });
    parent.down({ id: "control_1", kind: "control", control: { kind: "open_app", app: "Safari" } });
    expect(await parent.until((message) => message.id === "control_1")).toMatchObject({
      kind: "control",
      done: expect.stringContaining("open Safari"),
    });
    parent.down({
      id: "control_2",
      kind: "control",
      control: { kind: "shell", command: "rm -rf /" },
    });
    expect(await parent.until((message) => message.id === "control_2")).toMatchObject({
      kind: "error",
      error: expect.stringContaining("control.kind"),
    });
    await child.close();
  });
});

/** The child's own process: a forked Node running the real frame transport. */
describe("the child as a process", () => {
  const source = (file: string) =>
    NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, file)).href;

  it("ends its task and exits when the parent disconnects", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ada-helper-"));
    const script = NodePath.join(dir, "helper.mts");
    const settled = NodePath.join(dir, "settled");
    await NodeFSP.writeFile(
      script,
      `import * as NodeProcess from "node:process";
import * as NodeFSP from "node:fs/promises";
import { createChild, nodeTransport } from ${JSON.stringify(source("child.ts"))};
import { FakeNotes } from ${JSON.stringify(source("fake.ts"))};
// The marker is written only once the run has settled, and waited for before the process exits.
const child = createChild({ transport: nodeTransport(), mac: () => ({ desktop: new FakeNotes(), tabs: null, dock: null, apps: null, controls: null }) });
void child.done.then(async () => {
  await NodeFSP.writeFile(${JSON.stringify(settled)}, "settled");
  NodeProcess.exit(0);
});
`,
    );
    const forked = NodeChildProcess.fork(script, [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const frame = (kind: string) =>
      new Promise<void>((resolve) => {
        forked.on("message", (message) => {
          if (typeof message === "string" && message.includes(`"kind":"${kind}"`)) resolve();
        });
      });
    const started = frame("started");
    const decided = frame("decide");
    try {
      forked.send(
        `${JSON.stringify({ id: "task_1", kind: "start", task: { goal: "search my notes for groceries", text: "groceries" } })}\n`,
      );
      await started;
      await decided;
      // Waiting for a decision this parent never answers: only the disconnect can end it.
      expect(forked.exitCode).toBeNull();
      await expect(NodeFSP.readFile(settled, "utf8")).rejects.toThrow();
      const exited = new Promise<number | null>((resolve) =>
        forked.once("exit", (code) => resolve(code)),
      );
      forked.disconnect();
      expect(await exited).toBe(0);
      expect(await NodeFSP.readFile(settled, "utf8")).toBe("settled");
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
