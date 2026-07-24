// Attach-or-spawn resolution for the desktop's primary local backend.
//
// The desktop normally spawns `apps/server/dist/bin.mjs` as a child that owns
// the state dir. When an external backend (typically a systemd-owned
// `t3 serve`) is already running against the SAME state dir, the desktop can
// instead ATTACH to it: skip spawning, talk to the existing origin, and let
// agent threads survive the desktop quitting.
//
// The pure decision (`resolveAttachDecision`) is separated from IO so it can be
// unit-tested with faked probes. The real probe builders below wire the
// filesystem / process / HTTP implementations the configuration layer uses.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Duration from "effect/Duration";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as DesktopObservability from "../app/DesktopObservability.ts";

const { logInfo: logAttachInfo, logWarning: logAttachWarning } =
  DesktopObservability.makeComponentLogger("desktop-backend-attach");

// Subset of `<stateDir>/server-runtime.json` the desktop needs to attach. The
// server writes more fields; Schema.Struct ignores the rest on decode.
export const PersistedRuntimeStateProbe = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  origin: Schema.String,
});
export type PersistedRuntimeStateProbe = typeof PersistedRuntimeStateProbe.Type;

// A live external backend the desktop successfully probed.
export interface ProbedEnvironment {
  readonly serverVersion: Option.Option<string>;
}

export type AttachDecision =
  | {
      readonly _tag: "attach";
      readonly origin: string;
      readonly token: string;
      readonly pid: number;
    }
  | { readonly _tag: "wait"; readonly reason: string }
  | { readonly _tag: "spawn"; readonly reason: string };

// Injected IO, faked in tests. Each step is only run when the prior one
// keeps the attach path alive, so a fake need only implement what its case
// exercises.
export interface AttachProbeContext {
  // T3CODE_DESKTOP_NO_ATTACH escape hatch — forces always-spawn.
  readonly noAttach: boolean;
  readonly appVersion: string;
  readonly readRuntimeState: Effect.Effect<Option.Option<PersistedRuntimeStateProbe>>;
  readonly isPidAlive: (pid: number) => Effect.Effect<boolean>;
  readonly probeEnvironment: (origin: string) => Effect.Effect<Option.Option<ProbedEnvironment>>;
  readonly readAttachToken: Effect.Effect<Option.Option<string>>;
}

const spawn = (reason: string): AttachDecision => ({ _tag: "spawn", reason });
const wait = (reason: string): AttachDecision => ({ _tag: "wait", reason });

const parseHttpOrigin = (origin: string): Option.Option<URL> => {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? Option.some(parsed)
      : Option.none();
  } catch {
    return Option.none();
  }
};

// Pure attach-or-spawn decision. Falls back to spawn on any failing gate (no
// runtime file, dead pid, no HTTP answer, unreadable token), so behavior is
// unchanged when no external backend exists.
export const resolveAttachDecision = (context: AttachProbeContext): Effect.Effect<AttachDecision> =>
  Effect.gen(function* () {
    if (context.noAttach) {
      return spawn("T3CODE_DESKTOP_NO_ATTACH set");
    }

    const runtimeState = yield* context.readRuntimeState;
    if (Option.isNone(runtimeState)) {
      return spawn("no server-runtime.json for the target state dir");
    }
    const { pid, origin } = runtimeState.value;
    const parsedOrigin = parseHttpOrigin(origin);
    if (Option.isNone(parsedOrigin)) {
      return spawn(`server-runtime.json contains an invalid origin: ${origin}`);
    }
    const resolvedOrigin = parsedOrigin.value.href;

    const alive = yield* context.isPidAlive(pid);
    if (!alive) {
      return spawn(`recorded backend pid ${pid} is not alive`);
    }

    const probed = yield* context.probeEnvironment(resolvedOrigin);
    if (Option.isNone(probed)) {
      return spawn(`existing backend at ${resolvedOrigin} did not answer the environment probe`);
    }

    const token = yield* context.readAttachToken;
    if (Option.isNone(token)) {
      // A live, healthy backend demonstrably owns this state directory. Never
      // spawn a competing child merely because its attach credential is
      // temporarily unavailable; retry configuration until the token appears
      // or the external backend goes away.
      return wait("local attach token file is missing or unreadable");
    }

    // Version skew is not fatal: attach anyway and let the web app surface
    // its existing mismatch guidance. Just record it on the desktop side.
    yield* Option.match(probed.value.serverVersion, {
      onNone: () => Effect.void,
      onSome: (serverVersion) =>
        serverVersion === context.appVersion
          ? Effect.void
          : logAttachWarning("attaching to a backend with a mismatched version", {
              appVersion: context.appVersion,
              serverVersion,
              origin: resolvedOrigin,
            }),
    });

    yield* logAttachInfo("attaching to existing local backend", { origin: resolvedOrigin, pid });
    return { _tag: "attach", origin: resolvedOrigin, token: token.value, pid };
  });

// ---------------------------------------------------------------------------
// Real probe implementations
// ---------------------------------------------------------------------------

const ENVIRONMENT_PROBE_PATH = "/.well-known/t3/environment";
const ENVIRONMENT_PROBE_TIMEOUT = Duration.seconds(2);

class InvalidEnvironmentOriginError extends Schema.TaggedErrorClass<InvalidEnvironmentOriginError>()(
  "InvalidEnvironmentOriginError",
  {
    origin: Schema.String,
  },
) {}

const decodeRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedRuntimeStateProbe),
);

// Reads and decodes `<stateDir>/server-runtime.json`. A missing/empty/corrupt
// file yields None (→ spawn) rather than failing the resolve.
export const makeReadRuntimeState = (
  serverRuntimeStatePath: string,
): Effect.Effect<Option.Option<PersistedRuntimeStateProbe>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(serverRuntimeStatePath).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(raw)) {
      return Option.none();
    }
    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none();
    }
    return yield* decodeRuntimeState(trimmed).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none()),
    );
  });

// `process.kill(pid, 0)` probes existence without signaling. EPERM means the
// process exists but is owned by someone else (still "alive"); ESRCH means
// gone. Any throw other than a clean success we treat conservatively via the
// error code.
export const isProcessAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  });

// GETs the environment descriptor. Returns None on any non-2xx / transport
// failure / timeout so the caller falls back to spawn.
export const makeProbeEnvironment = (
  origin: string,
): Effect.Effect<Option.Option<ProbedEnvironment>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const requestUrl = yield* Effect.try({
      try: () => new URL(ENVIRONMENT_PROBE_PATH, origin).toString(),
      catch: () => new InvalidEnvironmentOriginError({ origin }),
    });
    const response = yield* client
      .execute(HttpClientRequest.get(requestUrl))
      .pipe(Effect.timeout(ENVIRONMENT_PROBE_TIMEOUT));
    if (response.status < 200 || response.status >= 300) {
      return Option.none<ProbedEnvironment>();
    }
    const body = yield* response.json;
    const serverVersion =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { serverVersion?: unknown }).serverVersion === "string"
        ? Option.some((body as { serverVersion: string }).serverVersion)
        : Option.none<string>();
    return Option.some({ serverVersion });
  }).pipe(Effect.orElseSucceed(() => Option.none<ProbedEnvironment>()));

// Reads `<stateDir>/local-attach-token` (single line). Missing/empty → None.
export const makeReadAttachToken = (
  localAttachTokenPath: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(localAttachTokenPath).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(raw)) {
      return Option.none();
    }
    const token = raw.value.trim();
    return token.length > 0 ? Option.some(token) : Option.none();
  });

export const serverRuntimeStatePathFor = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "server-runtime.json");

export const localAttachTokenPathFor = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "local-attach-token");
