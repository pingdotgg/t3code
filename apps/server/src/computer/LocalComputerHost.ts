// @effect-diagnostics nodeBuiltinImport:off -- the helper is a Node child process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

import type {
  ComputerGrant,
  ComputerHostAccess,
  ComputerHostConnectInput,
  ComputerHostFrame,
  ComputerHostId,
  ComputerTaskId,
} from "@t3tools/contracts";
import { COMPUTER_CONTROL_KINDS } from "@t3tools/contracts";
import type { ChildMessage, ChildRequest } from "@t3tools/computer-helper/child";
import type { ServerSettings as ServerSettingsValue } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { serverBuildVersion } from "../buildVersion.ts";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerService from "./ComputerService.ts";

/**
 * The standalone server's own computer: forked from `packages/computer-helper` when a macOS server runs
 * outside the desktop app and the person let agents use this computer. Grants attach to the terminal
 * that launched `t3`, so nothing here asks macOS for anything.
 */

/** How long the helper has to report its access before this computer is left unoffered. */
const HELPER_START_TIMEOUT = Duration.seconds(15);
/** A helper that exits leaves this computer unoffered for this long before it is asked again. */
const HELPER_RESTART_DELAY = Duration.seconds(10);

const NOT_MACOS = "Computer use runs on macOS in this version";

/**
 * Why this server may not offer its computer, or null when it may. The desktop app hosts this computer
 * itself, and only macOS has a helper worth forking.
 */
const localHostRefusal = (
  computerLocalHost: boolean | undefined,
  platform: NodeJS.Platform,
): string | null => {
  if (computerLocalHost === false)
    return "The desktop app hosts this computer, so this server does not.";
  if (platform !== "darwin") return NOT_MACOS;
  return null;
};

type Access = Extract<ChildMessage, { kind: "access" }>["access"];

const toHostAccess = (access: Access): ComputerHostAccess => ({
  computerUse: access.accessibility,
  accessibility: access.accessibility,
  screenRecording: access.screenRecording,
});

/** A forked helper: newline-delimited JSON in and out, and the end of its process. */
export type HelperChild = {
  readonly send: (frame: ChildRequest) => void;
  readonly onMessage: (handler: (message: ChildMessage) => void) => void;
  readonly onExit: (handler: () => void) => void;
  readonly stop: () => void;
};

const helperArguments = () => {
  const fromSource = import.meta.url.endsWith(".ts");
  // A single executable hosts the helper itself; a bundle's entry sits beside the server's.
  if (NodeSea.isSea()) return { args: ["__computer-helper"] };
  const entry = NodeURL.fileURLToPath(
    new URL(fromSource ? "../bin.ts" : "./bin.mjs", import.meta.url),
  );
  return {
    args: [...(fromSource ? ["--experimental-strip-types"] : []), entry, "__computer-helper"],
  };
};

/** The real child: the helper runs as plain Node, so macOS grants it the launching app's access. */
const forkHelper = (): HelperChild => {
  const child = NodeChildProcess.spawn(process.execPath, helperArguments().args, {
    // Electron's default macOS Helper executable lacks the app's Accessibility grant.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const messageHandlers: Array<(message: ChildMessage) => void> = [];
  const exitHandlers: Array<() => void> = [];
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    for (const handler of exitHandlers) handler();
  };
  child.on("message", (line) => {
    if (typeof line !== "string") return;
    for (const part of line.split("\n")) {
      if (!part.trim()) continue;
      let message: ChildMessage;
      try {
        message = JSON.parse(part) as ChildMessage;
      } catch {
        continue;
      }
      for (const handler of messageHandlers) handler(message);
    }
  });
  child.once("exit", end);
  child.once("error", end);
  child.once("disconnect", end);
  return {
    send: (frame) => {
      if (!ended && child.connected) child.send(frame);
    },
    onMessage: (handler) => {
      messageHandlers.push(handler);
    },
    onExit: (handler) => {
      exitHandlers.push(handler);
    },
    stop: () => {
      end();
      child.kill();
    },
  };
};

/** A test supplies its own helper; a standalone server forks the real one. */
export const HelperFork = Context.Reference<() => HelperChild>(
  "t3/computer/LocalComputerHost/HelperFork",
  { defaultValue: () => forkHelper },
);

/** A host frame as the helper's protocol asks for it. The welcome is the server's own. */
function toChildRequest(frame: ComputerHostFrame): ChildRequest | null {
  switch (frame.kind) {
    case "welcome":
      return null;
    case "start":
      // The task id doubles as the request id, so every reply about this task carries it back.
      return {
        id: frame.taskId,
        kind: "start",
        task: {
          goal: frame.goal,
          text: frame.text,
          ...(frame.act === undefined ? {} : { act: frame.act }),
        },
        limits: { maxSteps: frame.limits.maxSteps, timeoutMs: frame.limits.timeoutMs },
      };
    case "look":
      return {
        id: frame.requestId,
        kind: "look",
        screenshot: frame.screenshot,
        ...(frame.app === undefined ? {} : { app: frame.app }),
        ...(frame.region === undefined ? {} : { region: frame.region }),
      };
    case "stop":
      return { id: frame.requestId, kind: "stop", taskId: frame.taskId, reason: frame.reason };
    case "control":
      return { id: frame.requestId, kind: "control", control: frame.control };
  }
}

/** One helper session: the computer it reports, then the frames it and the server exchange. Ends when the helper does. */
const makeSession = Effect.scoped(
  Effect.gen(function* () {
    const computer = yield* ComputerService.ComputerService;
    const hostname = yield* HostProcess.Hostname;
    const fork = yield* HelperFork;
    const queue = yield* Queue.unbounded<ChildMessage, Cause.Done>();
    const access = yield* Deferred.make<Access>();
    // The task id a `start` named, so its `started` frame can answer that exact request. A send is synchronous.
    const starts = new Map<ComputerTaskId, string>();
    const hostIdRef = yield* Ref.make<ComputerHostId | null>(null);

    const child = yield* Effect.acquireRelease(
      Effect.sync(() => fork()),
      (child) => Effect.sync(() => child.stop()),
    );
    child.onMessage((message) => {
      // The first report is the hello; later ones are the checks each task's start asks for.
      if (
        message.kind === "access" &&
        Deferred.doneUnsafe(access, Effect.succeed(message.access))
      ) {
        return;
      }
      Queue.offerUnsafe(queue, message);
    });
    child.onExit(() => Queue.endUnsafe(queue));
    child.send({ id: "access", kind: "access" });

    const reported = yield* Deferred.await(access).pipe(Effect.timeoutOption(HELPER_START_TIMEOUT));
    if (Option.isNone(reported)) {
      yield* Effect.logWarning(
        "The computer helper did not answer, so this computer is not offered to agents.",
      );
      return;
    }
    const accessReport = reported.value;

    const answer = Effect.fn("LocalComputerHost.answer")(function* (message: ChildMessage) {
      const hostId = yield* Ref.get(hostIdRef);
      if (hostId === null) return;
      switch (message.kind) {
        case "started": {
          const requestId = starts.get(message.taskId);
          if (requestId === undefined) return;
          starts.delete(message.taskId);
          yield* computer.hostRespond({ hostId, reply: { requestId, ok: true } });
          return;
        }
        case "step":
          yield* computer.hostEvent({
            hostId,
            taskId: message.taskId,
            event: { type: "step", text: message.text },
          });
          return;
        case "finished":
          yield* computer.hostEvent({
            hostId,
            taskId: message.taskId,
            event: {
              type: "finished",
              status: message.outcome.status,
              reason: message.outcome.reason,
              steps: message.outcome.steps,
              surface: message.outcome.surface,
            },
          });
          return;
        case "control":
          yield* computer.hostRespond({
            hostId,
            reply: { requestId: message.id, ok: true, done: message.done },
          });
          return;
        case "look":
          yield* computer.hostRespond({
            hostId,
            reply: { requestId: message.id, ok: true, look: message.look },
          });
          return;
        case "acted":
          yield* computer.hostEvent({
            hostId,
            taskId: message.taskId,
            event: { type: "acted", kind: message.action, mode: message.mode, how: message.how },
          });
          return;
        case "error": {
          // A failed `start` carries the task id; a failed `control` carries its request id.
          const startRequest = starts.get(message.id);
          starts.delete(message.id);
          yield* computer.hostRespond({
            hostId,
            reply: { requestId: startRequest ?? message.id, ok: false, error: message.error },
          });
          return;
        }
        case "decide": {
          const answers = yield* computer
            .hostDecide({
              hostId,
              taskId: message.taskId,
              state: message.state,
              questions: message.questions,
            })
            .pipe(Effect.orElseSucceed(() => ({}) as const));
          child.send({ id: message.id, kind: "answers", answers });
          return;
        }
        case "authorize": {
          const grant: ComputerGrant = yield* computer
            .hostAuthorize({
              hostId,
              taskId: message.taskId,
              step: message.request.step,
              observation: message.request.observation,
              action: message.request.action,
            })
            .pipe(Effect.orElseSucceed((error) => ({ ok: false as const, denied: error.detail })));
          child.send({ id: message.id, kind: "grant", grant });
          return;
        }
        case "access":
          yield* computer.hostAccess({ hostId, access: toHostAccess(message.access) });
          return;
        case "current":
          return;
      }
    });

    // A frame the server refused never stops the session: the helper keeps asking.
    const reply = (message: ChildMessage) =>
      answer(message).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The computer helper sent a frame that could not be answered", {
            cause,
          }),
        ),
      );

    const hello: ComputerHostConnectInput = {
      name: hostname,
      // One host a device: a restart replaces this computer instead of adding a second.
      device: `standalone-${hostname}`,
      platform: "darwin",
      version: serverBuildVersion,
      controls: [...COMPUTER_CONTROL_KINDS],
      ...toHostAccess(accessReport),
    };

    const attached = yield* computer.attachLocalHost({
      ...hello,
      send: (frame) => {
        // A send is synchronous, so the map is written and read without a fiber between.
        if (frame.kind === "start") starts.set(frame.taskId, frame.requestId);
        // A grant made after this host attached reaches the server with the task or look it was made for.
        if (frame.kind === "start" || frame.kind === "look") {
          child.send({ id: "access", kind: "access" });
        }
        const request = toChildRequest(frame);
        if (request !== null) child.send(request);
      },
    });
    yield* Ref.set(hostIdRef, attached.hostId);
    yield* Effect.addFinalizer(() => attached.detach);
    yield* Effect.logInfo("This computer is offered to agents", {
      hostId: attached.hostId,
      accessibility: hello.accessibility,
      screenRecording: hello.screenRecording,
    });

    yield* Stream.runForEach(Stream.fromQueue(queue), reply);
    yield* Effect.logInfo("The computer helper stopped, so this computer is no longer offered.");
  }),
);

/** The setting is project-scoped: the host is offered when this environment lets any project use it. */
const computerUseEnabled = (settings: ServerSettingsValue): boolean =>
  settings.enableAgentComputerUse ||
  Object.values(settings.projectSettingsOverrides).some(
    (project) => project.enableAgentComputerUse === true,
  );

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  // The desktop app hosts this computer itself, so its bundled server never forks a second helper.
  const refusal = localHostRefusal(config.computerLocalHost, yield* HostProcess.Platform);
  if (refusal !== null) {
    yield* Effect.logInfo(refusal);
    return;
  }
  const settings = yield* ServerSettings.ServerSettingsService;

  const wanted = Stream.unwrap(
    Effect.gen(function* () {
      const changes = yield* settings.subscribeChanges;
      const current = yield* settings.getSettings.pipe(
        Effect.map(computerUseEnabled),
        Effect.orElseSucceed(() => false),
      );
      return Stream.concat(Stream.succeed(current), Stream.map(changes, computerUseEnabled));
    }),
  );

  yield* forkParked(
    wanted.pipe(
      Stream.changes,
      Stream.switchMap((on) =>
        on
          ? Stream.fromEffect(makeSession).pipe(
              // A helper that exits is asked again after a pause, so one crash does not close this computer.
              Stream.repeat(Schedule.spaced(HELPER_RESTART_DELAY)),
            )
          : Stream.empty,
      ),
      Stream.runDrain,
    ),
  );
});

export const layer = Layer.effectDiscard(make);
