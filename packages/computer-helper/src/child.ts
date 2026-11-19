// Ada's computer-use helper child. Its loop, backends and stop are ported from LocalRouter @fe24726; this entry is new.
import * as NodeProcess from "node:process";
import { ComputerUse, ComputerUseRuns, settled as settledRead } from "./controller.ts";
import type {
  Authorize,
  AuthorizeRequest,
  ComputerAct,
  ComputerOutcome,
  ComputerTask,
  Grant,
  Limits,
  Session,
} from "./controller.ts";
import type { Answers, Decider, Question } from "./decisions.ts";
import { parseAnswers } from "./decisions.ts";
import { DesktopBackend, macAccess } from "./desktop.ts";
import type { MacAccess } from "./desktop.ts";
import { ChromeTabs } from "./chromeTabs.ts";
import { DockApps } from "./dock.ts";
import { createLogger } from "./log.ts";
import type { Logger } from "./log.ts";
import { MacControls, parseControl } from "./macControls.ts";
import type { ComputerControl } from "./macControls.ts";
import { LocalStop } from "./stop.ts";
import type {
  BrowserTabs,
  Observation,
  Point,
  Rect,
  ScreenBackend,
  ScreenControl,
} from "./types.ts";

/** The fixed controls the server can ask this computer for, and the notice a task start shows. */
export type MacControlRunner = {
  run(control: ComputerControl): Promise<{ done: string }>;
  notify(title: string, text: string): Promise<void>;
};

/** What the child can drive on this computer. `null` members are not available here. */
export type Mac = {
  desktop: ScreenBackend | null;
  tabs: BrowserTabs | null;
  dock: { list(): Promise<string[]>; activate(name: string): Promise<unknown> } | null;
  apps: { running(): Promise<string[]>; activate(name: string): Promise<void> } | null;
  controls: MacControlRunner | null;
  urls?: { open(url: string): Promise<string>; browser?(): Promise<string> } | null;
};

/** A window as a look reads it: the observation, and a PNG of it when asked or when it lists no controls. */
const REAL_CLOCK = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export type Look = Omit<Observation, "backend" | "window" | "text"> & {
  text: string;
  screenshot?: {
    mimeType: "image/png";
    data: string;
    width: number;
    height: number;
    region: Rect;
    scale: number;
  };
};

/** A request from the server that runs the helper. Its `id` is repeated on every reply about it. */
export type ChildRequest =
  | { id: string; kind: "start"; task: ComputerTask & { act?: ComputerAct }; limits?: Limits }
  /** Reads a window without changing anything. */
  | { id: string; kind: "look"; app?: string; screenshot?: boolean; region?: Rect }
  | { id: string; kind: "stop"; taskId?: string; reason?: string }
  | { id: string; kind: "control"; control: unknown }
  | { id: string; kind: "status" }
  | { id: string; kind: "access" }
  /** The server's answer to a `decide` frame. */
  | { id: string; kind: "answers"; answers: unknown }
  /** The server's answer to an `authorize` frame. */
  | { id: string; kind: "grant"; grant: unknown };

/** A frame the child sends up. `decide` and `authorize` are questions the server answers with `answers` and `grant`. */
export type ChildMessage =
  | { id: string; kind: "started"; taskId: string }
  | { id: string; kind: "step"; taskId: string; text: string }
  | { id: string; kind: "finished"; taskId: string; outcome: ComputerOutcome }
  | { id: string; kind: "current"; current: { id: string; goal: string } | null }
  | { id: string; kind: "access"; access: MacAccess }
  | { id: string; kind: "control"; done: string }
  | { id: string; kind: "look"; look: Look }
  /** How one action reached the app and where, for the audit and the overlay; never what it typed. */
  | {
      id: string;
      kind: "acted";
      taskId: string;
      action: string;
      mode: "background" | "pointer";
      how: string;
      at?: Point;
    }
  | { id: string; kind: "error"; error: string }
  | {
      id: string;
      kind: "decide";
      taskId: string;
      state: unknown;
      questions: Record<string, Question>;
    }
  | { id: string; kind: "authorize"; taskId: string; request: AuthorizeRequest };

/** The parent's end of the channel: newline-delimited JSON frames, one object per line. */
export type ChildTransport = {
  /** Sends one frame; the child appends the newline. */
  send(frame: string): void;
  /** Every chunk the parent sends, which may hold part of a frame or several. */
  receive(handler: (chunk: string) => void): void;
  /** The parent went away. */
  onClose(handler: () => void): void;
};

export type ChildOptions = {
  transport: ChildTransport;
  /** Built on first use, so a host without a desktop session touches nothing. */
  mac?: () => Mac;
  log?: Logger;
};

export type Child = {
  /** Stops the running task and refuses further requests. Resolves once the task has settled. */
  close(reason?: string): Promise<void>;
  /** Resolves once the parent's channel closed and any running task has settled. */
  done: Promise<void>;
};

/** Why a task ended when the server that started it disconnected. */
export const PARENT_GONE = "The Ada server that started this task disconnected.";

/**
 * The helper's child: one computer-use task at a time, the server deciding each step and granting each action.
 * Nothing runs without the server, so a disconnect ends the task at once.
 */
export function createChild(options: ChildOptions): Child {
  const log = options.log ?? createLogger();
  const transport = options.transport;
  let mac: Mac | null = null;
  const machine = () => (mac ??= options.mac ? options.mac() : defaultMac());
  const pending = new Map<
    string,
    { resolve: (frame: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  /** The task the server started, if one is running, so its frames carry that task's id. */
  let taskId: string | null = null;
  let closed = false;
  let settled: Promise<void> = Promise.resolve();
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  /** A closed channel cannot be written to, so a frame after it is not sent. */
  const reply = (message: ChildMessage) => {
    if (closed) return;
    try {
      transport.send(JSON.stringify(message));
    } catch (error) {
      log.warn("computer_child.send_failed", { kind: message.kind, error: messageOf(error) });
    }
  };

  const request = <T>(frame: { id: string } & Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed) return reject(new Error(PARENT_GONE));
      pending.set(frame.id, { resolve: (answer) => resolve(answer as T), reject });
      transport.send(JSON.stringify(frame));
    });

  const decider: Decider = {
    ask: async (state, questions): Promise<Answers> => {
      const answer = await request<{ answers: unknown }>({
        id: nextId("decide"),
        kind: "decide",
        taskId: taskId ?? "",
        state,
        questions,
      });
      return parseAnswers(answer.answers);
    },
  };

  const authorize: Authorize = async (ask) => {
    const answer = await request<{ grant: unknown }>({
      id: nextId("grant"),
      kind: "authorize",
      taskId: taskId ?? "",
      request: ask,
    });
    return grantOf(answer.grant);
  };

  const localStop = (): LocalStop | null => {
    const desktop = machine().desktop;
    if (!desktop?.pointer) return null;
    return new LocalStop({
      pointer: () => desktop.pointer!(),
      ...(desktop.displays ? { displays: () => desktop.displays!() } : {}),
      log,
    });
  };

  /** Refuses every question still waiting on the server, so a run never outlives the answer. */
  const abandon = (reason: string) => {
    for (const entry of pending.values()) entry.reject(new Error(reason));
    pending.clear();
  };

  const landed = new Map<string, string>();
  const refs = new Map<string, ScreenControl>();
  const popupSeen = { text: "" };
  const runs = new ComputerUseRuns({
    create: (session: Session) => {
      const { desktop, tabs, dock, apps, urls } = machine();
      return new ComputerUse({
        ...session,
        desktop,
        tabs,
        dock,
        apps,
        urls: urls ?? null,
        landed,
        refs,
        popupSeen,
        log,
      });
    },
    watch: (abort) =>
      localStop()?.watch((reason) => {
        abort(reason);
        abandon(reason);
      }) ?? null,
    // One notice a goal: an agent's single acts would post one per click.
    onStart: (task) => {
      if (task.act) return;
      void machine().controls?.notify(
        "Ada is using this Mac",
        "To stop it, hold the pointer in the top-left corner.",
      );
    },
    log,
  });

  const start = (id: string, task: ComputerTask, limits: Limits = {}) => {
    if (taskId !== null) return reply({ id, kind: "error", error: "busy" });
    const session: Session = {
      decider,
      authorize,
      onStep: (text) => reply({ id, kind: "step", taskId: id, text }),
      onAct: (action, result) =>
        reply({
          id,
          kind: "acted",
          taskId: id,
          action: action.kind,
          mode: result.mode,
          how:
            result.how ??
            (result.mode === "pointer" ? "the real pointer, as allowed" : "in the background"),
          ...(result.at ? { at: result.at } : {}),
        }),
    };
    // An act can ask for its grant before runs.start returns, and that frame must name this task.
    taskId = id;
    const started = runs.start(id, task, session, limits);
    if (!started.ok) {
      taskId = null;
      return reply({ id, kind: "error", error: started.error });
    }
    reply({ id, kind: "started", taskId: id });
    settled = started.finished.then((outcome) => {
      if (taskId === id) taskId = null;
      reply({ id, kind: "finished", taskId: id, outcome });
    });
  };

  const stopTask = (reason: string, id?: string) => {
    if (!runs.stop(id, reason)) return false;
    abandon(reason);
    return true;
  };

  const handle = async (line: string) => {
    let frame: ChildRequest;
    try {
      frame = JSON.parse(line) as ChildRequest;
    } catch {
      log.warn("computer_child.unreadable_frame");
      return;
    }
    switch (frame.kind) {
      case "answers":
      case "grant": {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        entry.resolve(frame as unknown as Record<string, unknown>);
        return;
      }
      case "start":
        return start(frame.id, frame.task, frame.limits);
      case "stop":
        stopTask(frame.reason ?? "You stopped it.", frame.taskId);
        return reply({ id: frame.id, kind: "current", current: runs.current });
      case "status":
        return reply({ id: frame.id, kind: "current", current: runs.current });
      case "look": {
        try {
          return reply({ id: frame.id, kind: "look", look: await look(frame) });
        } catch (error) {
          return reply({ id: frame.id, kind: "error", error: messageOf(error) });
        }
      }
      case "control": {
        const controls = machine().controls;
        if (!controls)
          return reply({
            id: frame.id,
            kind: "error",
            error: "This computer does not run controls.",
          });
        try {
          const { done: said } = await controls.run(parseControl(frame.control));
          return reply({ id: frame.id, kind: "control", done: said });
        } catch (error) {
          return reply({ id: frame.id, kind: "error", error: messageOf(error) });
        }
      }
      case "access": {
        try {
          return reply({ id: frame.id, kind: "access", access: await macAccess() });
        } catch (error) {
          return reply({ id: frame.id, kind: "error", error: messageOf(error) });
        }
      }
    }
  };

  const look = async (frame: Extract<ChildRequest, { kind: "look" }>): Promise<Look> => {
    const desktop = machine().desktop;
    if (!desktop) throw new Error("Computer use needs accessibility access on this computer.");
    const {
      backend: _backend,
      window: _window,
      ...observed
    } = await settledRead(desktop, frame.app ? { app: frame.app } : {}, REAL_CLOCK);
    // Short refs ("e7") instead of long accessibility paths, which a model copies wrong; acts map them back.
    popupSeen.text = observed.popup ?? "";
    refs.clear();
    const controls = observed.controls.map((control, index) => {
      const ref = `e${index + 1}`;
      refs.set(ref, control);
      return { ...control, ref };
    });
    const seen: Look = { ...observed, controls, text: observed.text ?? "" };
    const wanted = frame.screenshot === true;
    if (!desktop.screenshot || (!wanted && seen.controls.length > 0)) return seen;
    const shot = await desktop
      .screenshot({
        ...(frame.app ? { app: frame.app } : {}),
        ...(frame.region ? { region: frame.region } : {}),
      })
      .catch((error: unknown) => {
        if (wanted) throw error;
        return null;
      });
    if (!shot) return seen;
    return {
      ...seen,
      screenshot: {
        mimeType: "image/png",
        data: Buffer.from(shot.png).toString("base64"),
        width: shot.width,
        height: shot.height,
        region: shot.region,
        scale: shot.scale,
      },
    };
  };

  const close = async (reason = PARENT_GONE) => {
    if (closed) return;
    closed = true;
    runs.stop(undefined, reason);
    abandon(reason);
    await settled;
    finish();
  };

  transport.receive((chunk) => {
    if (closed) return;
    for (const line of chunk.split("\n")) if (line.trim()) void handle(line);
  });
  transport.onClose(() => void close());

  return { close, done };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The server's grant, checked here so a malformed one never becomes an action. */
function grantOf(value: unknown): Grant {
  if (typeof value === "object" && value !== null) {
    const grant = value as { ok?: unknown; grant?: unknown; denied?: unknown };
    if (grant.ok === true && (grant.grant === "allow" || grant.grant === "approved"))
      return { ok: true, grant: grant.grant };
    if (grant.ok === false && typeof grant.denied === "string")
      return { ok: false, denied: grant.denied };
  }
  throw new Error("The server sent an unreadable grant.");
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${(counter += 1)}`;

/** `node:process`'s namespace carries named exports; the process object itself, with `on` and `send`, is its default. */
const hostProcess = () => (NodeProcess as unknown as { default: NodeJS.Process }).default;

/** The real Mac, built once: accessibility for the screen, Chrome's tabs, the Dock, and the fixed controls. */
function defaultMac(): Mac {
  const controls = new MacControls();
  return {
    desktop: new DesktopBackend(),
    tabs: new ChromeTabs(),
    dock: new DockApps(),
    apps: controls,
    controls,
    urls: { open: (url) => controls.openUrl(url), browser: () => controls.defaultBrowser() },
  };
}

/**
 * The live channel: a forked child's IPC (`process.send`), else stdin and stdout when the helper runs as a plain
 * process. Both carry the same newline-delimited JSON frames.
 */
export function nodeTransport(): ChildTransport {
  const host = hostProcess();
  const forked = typeof host.send === "function";
  return {
    send(frame) {
      const line = `${frame}\n`;
      if (forked) host.send?.(line);
      else host.stdout.write(line);
    },
    receive(handler) {
      if (forked) {
        host.on("message", (message) =>
          handler(typeof message === "string" ? message : JSON.stringify(message)),
        );
        return;
      }
      host.stdin.setEncoding("utf8");
      host.stdin.on("data", (chunk: string) => handler(chunk));
    },
    onClose(handler) {
      if (forked) {
        host.on("disconnect", handler);
        host.on("error", handler);
        host.on("SIGTERM", handler);
        return;
      }
      host.stdin.on("end", handler);
      host.stdin.on("close", handler);
    },
  };
}

/** Runs the helper as a child process: frames in, frames out, and exit once the parent is gone and the task settled. */
export function runChild(): Child {
  const child = createChild({ transport: nodeTransport() });
  void child.done.then(() => NodeProcess.exit(0));
  return child;
}
