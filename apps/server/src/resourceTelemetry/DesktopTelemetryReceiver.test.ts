// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import { assert, describe, expect } from "vite-plus/test";

import {
  type DesktopTelemetryReceiverHealth,
  initialDesktopTelemetryContactAt,
  isDesktopTelemetryContactStale,
  recordDesktopTelemetrySampleHealth,
  requireDesktopTelemetryWriteProgress,
  resolveDesktopTelemetrySnapshotStaleAfterMs,
  writeAllToFileDescriptor,
} from "./DesktopTelemetryReceiver.ts";

const receiverUrl = new URL("./DesktopTelemetryReceiver.ts", import.meta.url);

function runReceiverChild(mode: "crash" | "destroy" | "eof", fileFd?: number) {
  return new Promise<{
    output: string;
    error: string;
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import * as NodeServices from "@effect/platform-node/NodeServices";
          import * as Context from "effect/Context";
          import * as Effect from "effect/Effect";
          import * as Layer from "effect/Layer";
          import * as Stream from "effect/Stream";
          const url = ${JSON.stringify(receiverUrl.href)};
          const { make } = await import(url);
          const Config = await import(new URL("../config.ts", url));
          const Settings = await import(new URL("../serverSettings.ts", url));
          await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const context = yield* Layer.build(Config.layerTest(process.cwd(), {
              prefix: "t3-telemetry-exit-",
            }).pipe(Layer.provide(NodeServices.layer)));
            const config = Context.get(context, Config.ServerConfig);
            const receiver = yield* make().pipe(
              Effect.provideService(Config.ServerConfig, {
                ...config, mode: "desktop", desktopTelemetryFd: 4,
              }),
              Effect.provide(Settings.layerTest()),
            );
            const health = yield* receiver.subscribeHealth;
            process.stdout.write("ready\\n");
            yield* health.changes.pipe(
              Stream.filter((value) => value.status === "healthy"),
              Stream.take(1), Stream.runDrain,
            );
            process.stdout.write("telemetry received\\n");
            if (${JSON.stringify(mode)} === "crash") {
              setImmediate(() => { throw new Error("backend crashed"); });
              yield* Effect.never;
            }
            if (${JSON.stringify(mode)} === "eof") {
              yield* health.changes.pipe(
                Stream.filter((value) => value.status === "stopped"),
                Stream.take(1), Stream.runDrain,
              );
              process.stdout.write("telemetry EOF\\n");
            }
          })));
        `,
      ],
      {
        cwd: new URL("../../", receiverUrl),
        stdio: ["ignore", "pipe", "pipe", "ignore", fileFd ?? "pipe"],
        // A watchdog kills a hung regression; success always waits for the child's close event.
        timeout: 5_000,
        killSignal: "SIGKILL",
      },
    );
    let output = "";
    let error = "";
    let sent = false;
    const writer = child.stdio[4];
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (!sent && output.includes("ready\n") && writer && "write" in writer) {
        sent = true;
        writer.write('{"version":1,"type":"desktopTelemetryHello",');
        writer.write('"electronPid":123}\n');
      }
      if (mode === "eof" && output.includes("telemetry received\n") && writer && "end" in writer) {
        writer.end();
      }
    });
    child.stderr?.on("data", (chunk) => {
      error += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ output, error, code, signal }));
  });
}

describe("desktop telemetry process lifecycle", () => {
  it("exits after a crash with the desktop telemetry writer still open", async () => {
    const result = await runReceiverChild("crash");
    expect(result.output).toContain("telemetry received\n");
    expect(result.error).toContain("backend crashed");
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
  });

  it("closes its receiver scope with the desktop telemetry writer still open", async () => {
    const result = await runReceiverChild("destroy");
    expect(result.output).toContain("telemetry received\n");
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
  });

  it("decodes fragmented telemetry and observes EOF", async () => {
    const result = await runReceiverChild("eof");
    expect(result.output).toContain("telemetry EOF\n");
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
  });

  it("reads telemetry from a regular descriptor", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-telemetry-file-"));
    const path = NodePath.join(directory, "telemetry.ndjson");
    NodeFS.writeFileSync(path, '{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n');
    const fd = NodeFS.openSync(path, "r");
    try {
      const result = await runReceiverChild("destroy", fd);
      expect(result.output).toContain("telemetry received\n");
      expect(result.signal).toBeNull();
      expect(result.code).toBe(0);
    } finally {
      NodeFS.closeSync(fd);
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("DesktopTelemetryReceiver", () => {
  it("degrades a hello-only stream after the first-sample deadline", () => {
    expect(isDesktopTelemetryContactStale(Option.some(1_000), 90_999)).toBe(false);
    expect(isDesktopTelemetryContactStale(Option.some(1_000), 91_000)).toBe(true);
    expect(isDesktopTelemetryContactStale(Option.none(), 1_000_000)).toBe(false);
  });

  it("starts the stale deadline as soon as a telemetry descriptor is opened", () => {
    expect(initialDesktopTelemetryContactAt(7, 1_000)).toEqual(Option.some(1_000));
    expect(initialDesktopTelemetryContactAt(undefined, 1_000)).toEqual(Option.none());
  });

  it("keeps the snapshot deadline beyond the configured idle polling interval", () => {
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(30_000, 120_000)).toBe(150_000);
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(60_000, 600_000)).toBe(630_000);
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(1_000, 1_000)).toBe(90_000);
  });

  it.effect("publishes the latest sample timestamp while health remains healthy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialSample = DateTime.makeUnsafe(1_000);
        const nextSample = DateTime.makeUnsafe(2_000);
        const health = yield* Ref.make<DesktopTelemetryReceiverHealth>({
          status: "healthy",
          lastSampleAt: Option.some(initialSample),
          lastError: Option.none<string>(),
        });
        const healthChanges = yield* PubSub.sliding<DesktopTelemetryReceiverHealth>(4);
        const subscription = yield* PubSub.subscribe(healthChanges);

        yield* recordDesktopTelemetrySampleHealth(health, healthChanges, nextSample);
        const published = yield* PubSub.take(subscription).pipe(Effect.timeout("1 second"));

        expect(DateTime.toEpochMillis(Option.getOrThrow(published.lastSampleAt))).toBe(2_000);
      }),
    ),
  );

  it.effect("writes control messages through the asynchronous descriptor path", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const directory = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-desktop-telemetry-control-test-"),
        );
        const path = NodePath.join(directory, "control.ndjson");
        return {
          directory,
          path,
          fd: NodeFS.openSync(path, "w"),
        };
      }),
      ({ fd, path }) =>
        Effect.gen(function* () {
          const payload = Buffer.from('{"type":"setDiagnosticsDemand","enabled":true}\n');
          yield* writeAllToFileDescriptor(fd, payload);
          NodeFS.fsyncSync(fd);

          assert.equal(NodeFS.readFileSync(path, "utf8"), payload.toString("utf8"));
        }),
      ({ directory, fd }) =>
        Effect.sync(() => {
          NodeFS.closeSync(fd);
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
    ),
  );

  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );
});
