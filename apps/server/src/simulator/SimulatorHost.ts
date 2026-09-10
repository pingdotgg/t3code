// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { promisify } from "node:util";

import {
  SimulatorActionId,
  type SimulatorArtifact,
  type SimulatorCloseInput,
  type SimulatorLogsInput,
  type SimulatorMetricsInput,
  type SimulatorOpenInput,
  type SimulatorScreenshotInput,
  type SimulatorSession,
  SimulatorSessionId,
  type SimulatorSwipeInput,
  type SimulatorTapInput,
  type SimulatorTypeInput,
  type SimulatorVideoStartInput,
  type SimulatorVideoStartResult,
  SimulatorToolkitError,
  type SimulatorActionReceipt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Semaphore from "effect/Semaphore";

const execFile = promisify(NodeChildProcess.execFile);

export interface SimulatorHostShape {
  readonly open: (
    input: SimulatorOpenInput,
  ) => Effect.Effect<SimulatorSession, SimulatorToolkitError>;
  readonly tap: (
    input: SimulatorTapInput,
  ) => Effect.Effect<SimulatorActionReceipt, SimulatorToolkitError>;
  readonly swipe: (
    input: SimulatorSwipeInput,
  ) => Effect.Effect<SimulatorActionReceipt, SimulatorToolkitError>;
  readonly typeText: (
    input: SimulatorTypeInput,
  ) => Effect.Effect<SimulatorActionReceipt, SimulatorToolkitError>;
  readonly screenshot: (
    input: SimulatorScreenshotInput,
  ) => Effect.Effect<SimulatorArtifact, SimulatorToolkitError>;
  readonly videoStart: (
    input: SimulatorVideoStartInput,
  ) => Effect.Effect<SimulatorVideoStartResult, SimulatorToolkitError>;
  readonly videoStop: (
    input: SimulatorCloseInput,
  ) => Effect.Effect<SimulatorArtifact, SimulatorToolkitError>;
  readonly logs: (
    input: SimulatorLogsInput,
  ) => Effect.Effect<SimulatorArtifact, SimulatorToolkitError>;
  readonly metrics: (
    input: SimulatorMetricsInput,
  ) => Effect.Effect<import("@t3tools/contracts").SimulatorMetrics, SimulatorToolkitError>;
  readonly close: (input: SimulatorCloseInput) => Effect.Effect<void, SimulatorToolkitError>;
}

export class SimulatorHost extends Context.Service<SimulatorHost, SimulatorHostShape>()(
  "t3/simulator/SimulatorHost",
) {}

interface SessionState {
  readonly session: SimulatorSession;
  readonly nextActionId: number;
  readonly semaphore: Semaphore.Semaphore;
  readonly videoPath?: string;
  readonly videoProcess?: NodeChildProcess.ChildProcess;
}

interface DeviceInfo {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
  readonly isAvailable: boolean;
}

const fail = (code: SimulatorToolkitError["code"], detail: string) =>
  new SimulatorToolkitError({ code, detail });

const command = (file: string, args: ReadonlyArray<string>, maxBuffer = 2_000_000) =>
  Effect.tryPromise({
    try: async () => (await execFile(file, args, { maxBuffer })).stdout,
    catch: (error) => fail("command_failed", `${file} ${args.join(" ")}: ${String(error)}`),
  });

const commandIgnoringOutput = (file: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      await execFile(file, args, { maxBuffer: 2_000_000 });
    },
    catch: (error) => fail("command_failed", `${file} ${args.join(" ")}: ${String(error)}`),
  });

const requireMac = Effect.suspend(() =>
  NodeProcess.platform === "darwin"
    ? Effect.succeed(undefined)
    : Effect.fail(fail("unsupported_host", "iOS Simulator automation requires macOS.")),
);

const safeLabel = (label: string | undefined, fallback: string) =>
  (label ?? fallback).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || fallback;

const artifact = (kind: SimulatorArtifact["kind"], path: string) =>
  Effect.tryPromise({
    try: async () => {
      const bytes = await NodeFSP.readFile(path);
      return {
        kind,
        path,
        bytes: bytes.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      } satisfies SimulatorArtifact;
    },
    catch: (error) => fail("command_failed", `Could not read artifact ${path}: ${String(error)}`),
  });

const appleScriptFor = (
  kind: "tap" | "swipe" | "type",
  input: SimulatorTapInput | SimulatorSwipeInput | SimulatorTypeInput,
) => {
  if (kind === "tap") {
    const point = (input as SimulatorTapInput).point;
    return `tell application "System Events" to\n  delay 0.2\n  click at {${point.x}, ${point.y}}\nend tell`;
  }
  if (kind === "swipe") {
    const value = input as SimulatorSwipeInput;
    const seconds = Math.max(0.05, (value.durationMs ?? 350) / 1000);
    return `tell application "System Events" to\n  delay 0.2\n  set position of mouse to {${value.from.x}, ${value.from.y}}\n  mouse down\n  delay ${seconds}\n  set position of mouse to {${value.to.x}, ${value.to.y}}\n  mouse up\nend tell`;
  }
  const text = (input as SimulatorTypeInput).text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `tell application "System Events" to\n  delay 0.2\n  keystroke "${text}"\nend tell`;
};

const make = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make<ReadonlyMap<string, SessionState>>(new Map());
  const withSession = (id: SimulatorSessionId) =>
    Effect.flatMap(SynchronizedRef.get(state), (sessions) => {
      const found = sessions.get(id);
      return found
        ? Effect.succeed(found)
        : Effect.fail(fail("session_not_found", `Unknown simulator session ${id}.`));
    });
  const nextAction = (id: SimulatorSessionId) =>
    SynchronizedRef.modifyEffect(state, (sessions) => {
      const current = sessions.get(id);
      if (!current)
        return Effect.fail(fail("session_not_found", `Unknown simulator session ${id}.`));
      const startedAt = Date.now();
      const next = { ...current, nextActionId: current.nextActionId + 1 };
      return Effect.succeed([
        { id: SimulatorActionId.make(current.nextActionId), startedAt },
        new Map(sessions).set(id, next),
      ] as const);
    });
  const action = (
    input: SimulatorTapInput | SimulatorSwipeInput | SimulatorTypeInput,
    kind: "tap" | "swipe" | "type",
  ) =>
    Effect.gen(function* () {
      yield* requireMac;
      const session = yield* withSession(input.sessionId);
      return yield* session.semaphore.withPermit(
        Effect.gen(function* () {
          const { id: actionId, startedAt } = yield* nextAction(input.sessionId);
          yield* commandIgnoringOutput("open", ["-a", "Simulator"]);
          yield* commandIgnoringOutput("osascript", ["-e", appleScriptFor(kind, input)]);
          return {
            sessionId: session.session.sessionId,
            actionId,
            durationMs: Date.now() - startedAt,
            state: "completed",
          } satisfies SimulatorActionReceipt;
        }),
      );
    });
  const open: SimulatorHostShape["open"] = Effect.fn("SimulatorHost.open")(function* (input) {
    yield* requireMac;
    const raw = yield* command("xcrun", ["simctl", "list", "devices", "available", "-j"]);
    const parsed = JSON.parse(raw) as { devices: Record<string, DeviceInfo[]> };
    const devices = Object.entries(parsed.devices)
      .filter(([runtime]) => runtime.includes("iOS"))
      .flatMap(([, values]) => values)
      .filter((device) => device.isAvailable);
    const device =
      devices.find((item) =>
        input.udid ? item.udid === input.udid : item.name === input.deviceName,
      ) ?? devices.find((item) => input.deviceName === undefined);
    if (!device)
      return yield* Effect.fail(
        fail("device_not_found", "No available iOS simulator matched the requested device."),
      );
    if (device.state !== "Booted") {
      yield* commandIgnoringOutput("xcrun", ["simctl", "boot", device.udid]);
      yield* commandIgnoringOutput("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
    }
    if (input.appPath && input.appBundleId) {
      yield* commandIgnoringOutput("xcrun", ["simctl", "install", device.udid, input.appPath]);
      yield* commandIgnoringOutput("xcrun", [
        "simctl",
        "launch",
        device.udid,
        input.appBundleId,
        ...(input.launchArgs ?? []),
      ]);
    }
    const sessionId = SimulatorSessionId.make(`sim_${NodeCrypto.randomUUID()}`);
    const artifactDirectory = NodePath.join(NodeOS.tmpdir(), "t3-simulator", sessionId);
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(artifactDirectory, { recursive: true }),
      catch: (error) => fail("command_failed", String(error)),
    });
    const session = {
      sessionId,
      udid: device.udid,
      deviceName: device.name,
      state: "ready",
      artifactDirectory,
      ...(input.appBundleId ? { appBundleId: input.appBundleId } : {}),
    } satisfies SimulatorSession;
    const semaphore = yield* Semaphore.make(1);
    yield* SynchronizedRef.update(state, (sessions) =>
      new Map(sessions).set(sessionId, { session, nextActionId: 1, semaphore }),
    );
    return session;
  });
  const screenshot: SimulatorHostShape["screenshot"] = Effect.fn("SimulatorHost.screenshot")(
    function* (input) {
      yield* requireMac;
      const session = yield* withSession(input.sessionId);
      const path = NodePath.join(
        session.session.artifactDirectory,
        `${safeLabel(input.label, "screenshot")}.png`,
      );
      yield* commandIgnoringOutput("xcrun", [
        "simctl",
        "io",
        session.session.udid,
        "screenshot",
        path,
      ]);
      return yield* artifact("screenshot", path);
    },
  );
  const videoStart: SimulatorHostShape["videoStart"] = Effect.fn("SimulatorHost.videoStart")(
    function* (input) {
      yield* requireMac;
      const session = yield* withSession(input.sessionId);
      const path = NodePath.join(
        session.session.artifactDirectory,
        `${safeLabel(input.label, "recording")}.mp4`,
      );
      const process = NodeChildProcess.spawn(
        "xcrun",
        ["simctl", "io", session.session.udid, "recordVideo", "--codec=h264", "--force", path],
        { stdio: "ignore" },
      );
      yield* SynchronizedRef.update(state, (sessions) =>
        new Map(sessions).set(input.sessionId, {
          ...session,
          videoPath: path,
          videoProcess: process,
        }),
      );
      return {
        sessionId: input.sessionId,
        state: "recording",
        path,
      } satisfies SimulatorVideoStartResult;
    },
  );
  const videoStop: SimulatorHostShape["videoStop"] = Effect.fn("SimulatorHost.videoStop")(
    function* (input) {
      const session = yield* withSession(input.sessionId);
      if (!session.videoProcess || !session.videoPath)
        return yield* Effect.fail(
          fail("recording_not_started", "No recording is active for this simulator session."),
        );
      session.videoProcess.kill("SIGINT");
      if (session.videoProcess.exitCode === null) {
        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve) => session.videoProcess?.once("exit", () => resolve())),
          catch: (error) => fail("command_failed", String(error)),
        });
      }
      return yield* artifact("video", session.videoPath);
    },
  );
  const logs: SimulatorHostShape["logs"] = Effect.fn("SimulatorHost.logs")(function* (input) {
    yield* requireMac;
    const session = yield* withSession(input.sessionId);
    const path = NodePath.join(session.session.artifactDirectory, `logs-${Date.now()}.log`);
    const output = yield* command(
      "xcrun",
      [
        "simctl",
        "spawn",
        session.session.udid,
        "log",
        "show",
        "--last",
        `${input.lastSeconds ?? 30}s`,
        "--style",
        "compact",
      ],
      20_000_000,
    );
    yield* Effect.tryPromise({
      try: () => NodeFSP.writeFile(path, output),
      catch: (error) => fail("command_failed", String(error)),
    });
    return yield* artifact("logs", path);
  });
  const metrics: SimulatorHostShape["metrics"] = Effect.fn("SimulatorHost.metrics")(
    function* (input) {
      yield* requireMac;
      const session = yield* withSession(input.sessionId);
      const output = yield* command("xcrun", [
        "simctl",
        "spawn",
        session.session.udid,
        "top",
        "-l",
        "1",
        "-stats",
        "pid,cpu,mem",
      ]).pipe(Effect.catch(() => Effect.succeed("")));
      const match = /\s(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)([MGK])/u.exec(output);
      const multiplier = match?.[3] === "G" ? 1e9 : match?.[3] === "M" ? 1e6 : 1e3;
      return {
        sessionId: input.sessionId,
        sampledAt: new Date().toISOString(),
        cpuPercent: match ? Number(match[1]) : null,
        memoryBytes: match ? Number(match[2]) * multiplier : null,
      };
    },
  );
  const close: SimulatorHostShape["close"] = Effect.fn("SimulatorHost.close")(function* (input) {
    const sessions = yield* SynchronizedRef.get(state);
    const session = sessions.get(input.sessionId);
    if (!session) return;
    if (session.videoProcess) session.videoProcess.kill("SIGINT");
    yield* SynchronizedRef.update(state, (sessions) => {
      const next = new Map(sessions);
      next.delete(input.sessionId);
      return next;
    });
  });
  return {
    open,
    tap: (input) => action(input, "tap"),
    swipe: (input) => action(input, "swipe"),
    typeText: (input) => action(input, "type"),
    screenshot,
    videoStart,
    videoStop,
    logs,
    metrics,
    close,
  } satisfies SimulatorHostShape;
});

export const layer = Layer.effect(SimulatorHost, make);

export const appleScriptForInput = appleScriptFor;
