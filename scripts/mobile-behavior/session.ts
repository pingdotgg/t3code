// @effect-diagnostics nodeBuiltinImport:off - owns Metro.
/**
 * One device's run state, shared by mobile:behavior and mobile:metrics: an isolated server with a
 * long settled thread, a Metro serving a checkout with the behavior probe, and the dev client opened
 * on it and paired with the server. Everything stops when the caller's scope closes.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { APP_ID, DeviceError, makeDevice, SCHEME, type ProbeState } from "./device.ts";
import { freePort, startEnvironment, uuid, type EnvironmentOptions } from "./environment.ts";
import { serveReleaseBytecode } from "./release-bytecode.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");

/** This machine's address as the simulator sees it: the tailnet address, else the first LAN IPv4. */
export function reachableHost(): string {
  const tailnet = NodeChildProcess.spawnSync("tailscale", ["ip", "-4"], { encoding: "utf8" });
  const ip = tailnet.status === 0 ? tailnet.stdout.trim().split("\n")[0] : undefined;
  if (ip) return ip;
  const lan = Object.values(NodeOS.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal);
  return lan?.address ?? "127.0.0.1";
}

/**
 * `dev` serves the development bundle; `release` serves the production bundle as Hermes bytecode
 * (see release-bytecode.ts) to the same dev client.
 */
export type Build = "dev" | "release";

/** Metro with the behavior probe compiled in, stopped with its process group when the scope ends. */
export const startMetro = Effect.fn("session.startMetro")(function* (input: {
  readonly host: string;
  readonly out: string;
  /** The checkout whose app Metro serves; defaults to this one. */
  readonly checkout?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly build?: Build;
}) {
  const checkout = input.checkout ?? REPO_ROOT;
  const release = input.build === "release";
  const port = yield* freePort();
  // In release mode the app opens the bytecode proxy on `port`, which fronts Metro.
  const metroPort = release ? yield* freePort() : port;
  const log = NodeFS.openSync(NodePath.join(input.out, "metro.log"), "w");
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(
        "npx",
        [
          "expo",
          "start",
          "--dev-client",
          "--scheme",
          SCHEME,
          "--lan",
          "--port",
          String(metroPort),
          ...(release ? ["--no-dev", "--minify"] : []),
        ],
        {
          cwd: NodePath.join(checkout, "apps/mobile"),
          detached: true,
          stdio: ["ignore", log, log],
          env: {
            ...process.env,
            APP_VARIANT: "development",
            CI: "1",
            // Lazily fetched chunks sometimes arrive broken on pool emulators and throw SyntaxErrors.
            EXPO_NO_METRO_LAZY: "1",
            EXPO_PUBLIC_T3_BEHAVIOR_PROBE: "1",
            REACT_NATIVE_PACKAGER_HOSTNAME: input.host,
            ...input.env,
          },
        },
      ),
    ),
    (child) => Effect.sync(() => child.pid !== undefined && process.kill(-child.pid, "SIGTERM")),
  );
  const metro = `http://${input.host}:${port}`;
  for (let attempt = 0; ; attempt++) {
    const ready = yield* HttpClient.get(`http://${input.host}:${metroPort}/status`).pipe(
      Effect.flatMap((response) => response.text),
      Effect.provide(FetchHttpClient.layer),
      Effect.orElseSucceed(() => ""),
    );
    if (ready.includes("running")) break;
    if (attempt >= 120)
      return yield* new DeviceError({
        message: `Metro never started; see ${input.out}/metro.log.`,
      });
    yield* Effect.sleep("1 second");
  }
  if (!release) return metro;
  yield* Console.error("Compiling the production bundle to Hermes bytecode (a few minutes)...");
  const bytes = yield* serveReleaseBytecode({ port, metroPort, checkout, out: input.out });
  yield* Console.error(`Serving ${Math.round(bytes / 1024)} KB of release bytecode on ${metro}.`);
  return metro;
});

export interface SessionOptions {
  readonly out: string;
  readonly host: string;
  readonly agentDevice: string;
  readonly deviceConfig: string;
  readonly deviceSession: string;
  /** Simulator UDID; empty for a Simlock lease, whose gateway picks it. */
  readonly device: string;
  readonly deviceName: string;
  readonly fold?: "closed" | "open";
  readonly forgetOtherEnvironments: boolean;
  /** Turns in the long settled thread every run seeds. */
  readonly longTurns: number;
  readonly checkout?: string;
  readonly metroEnv?: Readonly<Record<string, string>>;
  readonly build?: Build;
  readonly environment?: EnvironmentOptions;
}

export const startSession = Effect.fn("session.start")(function* (options: SessionOptions) {
  const env = yield* startEnvironment({
    baseDir: NodePath.join(options.out, "env"),
    deviceHost: options.host,
    ...options.environment,
  });
  const tag = (yield* uuid).slice(0, 4);
  yield* Console.error(`Seeding a ${options.longTurns}-turn thread on ${env.origin}...`);
  const longTitle = `Long settled thread ${tag}`;
  const longThread: ThreadId = yield* env.longThread(longTitle, options.longTurns);

  const metro = yield* startMetro({
    host: options.host,
    out: options.out,
    ...(options.checkout ? { checkout: options.checkout } : {}),
    ...(options.metroEnv ? { env: options.metroEnv } : {}),
    ...(options.build ? { build: options.build } : {}),
  });
  const device = makeDevice({
    agentDevice: options.agentDevice,
    targetArgs: [
      "--platform",
      "ios",
      ...(options.device ? ["--udid", options.device] : []),
      "--config",
      options.deviceConfig,
      "--session",
      options.deviceSession,
    ],
    metro,
    deviceName: options.deviceName,
  });
  yield* Console.error(`Opening the dev client against ${metro}...`);
  // agent-device answers iOS's "Open in" prompt; the flags keep dev-menu chrome off the app.
  const metroUrl = new URL(metro);
  const launchUrl = `${SCHEME}://expo-development-client/?url=${encodeURIComponent(metro)}&disableOnboarding=1&__expo_disable_fab=1&__expo_disable_auto_launch=1`;
  yield* device
    .run(
      [
        "open",
        APP_ID,
        "--relaunch",
        "--metro-host",
        metroUrl.hostname,
        "--metro-port",
        metroUrl.port,
        "--launch-url",
        launchUrl,
      ],
      240_000,
    )
    .pipe(Effect.retry({ times: 2 }));
  for (let attempt = 0; ; attempt++) {
    const loaded = yield* device
      .evaluate("typeof __t3Behavior")
      .pipe(Effect.orElseSucceed(() => ""));
    if (loaded === "object") break;
    // iOS asks before a URL opens another app; busy hosts can miss the first accept.
    if (attempt % 5 === 0) yield* device.acceptOpenPrompt.pipe(Effect.ignore);
    if (attempt > 120)
      return yield* new DeviceError({
        message:
          "The probe never loaded. Is this a dev client built from this checkout's native fingerprint?",
      });
    yield* Effect.sleep("2 seconds");
  }
  if (options.fold) yield* device.fold(options.fold);
  const forget = (ids: ReadonlyArray<string>) =>
    device
      .evaluate(`__t3Behavior.forgetEnvironments(${JSON.stringify(ids)})`)
      .pipe(Effect.andThen(Effect.sleep("3 seconds")));
  const pair = Effect.gen(function* () {
    const pairing = yield* env.pairingUrl();
    yield* device.openUrl(
      `${SCHEME}://connections/new?pairingUrl=${encodeURIComponent(pairing)}&autoConnect=1`,
    );
  });
  yield* pair;
  // Registered once pairing starts, so a stopped run never leaves its environment in the app.
  yield* Effect.addFinalizer(() => forget([env.environmentId]).pipe(Effect.ignore));
  const seeded = (state: ProbeState) => state.homeList !== null && longThread in state.threads;
  // A busy pool simulator sometimes drops the first pairing link; a fresh credential retries it.
  yield* device
    .waitFor("the paired environment's threads on Home", seeded, 60_000)
    .pipe(
      Effect.catch(() =>
        pair.pipe(
          Effect.andThen(
            device.waitFor("the paired environment's threads on Home", seeded, 60_000),
          ),
        ),
      ),
    );
  // Other saved environments keep cached threads (some stuck working) that skew status cases.
  const others = (yield* device.state).environments.filter((id) => id !== env.environmentId);
  if (others.length > 0 && !options.forgetOtherEnvironments)
    return yield* new DeviceError({
      message: `The app has ${others.length} other saved environment(s). Use a simulator with no other connections, or pass --forget-other-environments to remove them.`,
    });
  if (others.length > 0) yield* forget(others);
  return { env, device, metro, longThread, longTitle, seeded };
});

export type Session = Effect.Success<ReturnType<typeof startSession>>;
