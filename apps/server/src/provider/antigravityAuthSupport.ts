import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - node:http hosts the one-shot loopback sink with no routing, logging, or middleware.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off - resolveAntigravityProfileDirectory is a pure sync helper, so it cannot use the Path service.
import * as NodePath from "node:path";

import type { AntigravityAuthMethod, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import type { AcpSpawnInput } from "./acp/AcpSessionRuntime.ts";

export const ANTIGRAVITY_AUTH_STDOUT_PREFIX =
  "Open the following link to authenticate the ACP server: ";
export const ANTIGRAVITY_AUTH_BROWSER_MARKER = "__T3_ANTIGRAVITY_AUTH_URL__";
export const ANTIGRAVITY_AUTH_SINK_ENV = "T3_ANTIGRAVITY_AUTH_SINK";
export const ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE =
  "Sign in to Antigravity in Settings before you continue.";

const maxAuthorizationUrlLength = 16_384;
const maxBrowserHelperLineLength =
  Math.max(ANTIGRAVITY_AUTH_BROWSER_MARKER.length, ANTIGRAVITY_AUTH_STDOUT_PREFIX.length) +
  maxAuthorizationUrlLength +
  2;
const maxStdoutLineBytes = 16 * 1024 * 1024;
const authPrefixBytes = new TextEncoder().encode(ANTIGRAVITY_AUTH_STDOUT_PREFIX);
const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString);
const decodeBrowserHelperUrl = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String));
const ProfileSettingsFile = Schema.Struct({
  auth: Schema.Struct({ type: Schema.String }),
  gcp: Schema.optional(
    Schema.Struct({
      project: Schema.optional(Schema.String),
      location: Schema.optional(Schema.String),
    }),
  ),
});
const encodeProfileSettings = Schema.encodeSync(Schema.fromJsonString(ProfileSettingsFile));
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const isAcpTransportError = Schema.is(AcpErrors.AcpTransportError);

// Python splits BROWSER on the platform path separator before it parses quotes.
// Keep this source free of both colons and semicolons. EPIPE must still exit 0
// so Python does not fall back to an OS browser after cancellation.
const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${ANTIGRAVITY_AUTH_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",` +
  `()=>process.exit(0))`;
// The agent's Python 3.10 webbrowser runs BROWSER as one executable with the
// URL as its only argument, and its stdout copy of the URL sits in a block
// buffer until the process exits. Sign-in therefore points BROWSER at the T3
// runtime and preloads this file through NODE_OPTIONS. Node resolves its entry
// argument as a path before preloads run, so the URL arrives as
// <cwd>/https:/host/path and is rebuilt here. The entry then fails to load,
// which the handler ignores until delivery has finished.
const browserPreloadSource = String.raw`"use strict";
const argument = process.argv[1];
const cwd = process.cwd();
const trimmed =
  typeof argument === "string" && argument.startsWith(cwd) ? argument.slice(cwd.length) : "";
const url = trimmed
  .replace(/^[\\/]+/, "")
  .replaceAll("\\", "/")
  .replace(/^https:\/(?!\/)/, "https://");
if (url.startsWith("https://")) {
  process.on("uncaughtException", () => {});
  const done = () => process.exit(0);
  const sink = process.env.${ANTIGRAVITY_AUTH_SINK_ENV};
  if (sink) {
    fetch(sink, { method: "POST", headers: { "content-type": "text/plain" }, body: url }).then(
      done,
      done,
    );
  } else {
    process.stderr
      .on("error", done)
      .write("${ANTIGRAVITY_AUTH_BROWSER_MARKER}" + JSON.stringify(url) + "\n", done);
  }
}
`;
const browserPreloadFileName = "t3-browser-preload.cjs";
const browserPreflightUrl = "https://example.invalid/t3-antigravity-browser-preflight";

const removedEnvironmentKeys = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
  ANTIGRAVITY_AUTH_SINK_ENV,
]);

export interface AntigravityProfile {
  readonly platform: NodeJS.Platform;
  readonly geminiHome: string;
  readonly acpDirectory: string;
  readonly tokenPath: string;
  readonly browserCommand: string;
  /** T3 runtime that sign-in launches instead of a browser. */
  readonly browserHelperPath: string;
  /** Preload that hands the sign-in URL to T3. Lives inside `acpDirectory`. */
  readonly browserPreloadPath: string;
}

/**
 * Credentials for the non-personal ACP auth methods. The agent reads the API
 * key from its environment and the GCP project and location from
 * `settings.json` in the profile. Empty strings mean "not set".
 */
export interface AntigravityAuthConfig {
  readonly authMethod: AntigravityAuthMethod;
  readonly apiKey: string;
  readonly gcpProject: string;
  readonly gcpLocation: string;
}

export const ANTIGRAVITY_PERSONAL_AUTH: AntigravityAuthConfig = {
  authMethod: "oauth-personal",
  apiKey: "",
  gcpProject: "",
  gcpLocation: "",
};

/** True for the two methods that open a Google sign-in page. */
export function antigravityAuthUsesBrowser(authMethod: AntigravityAuthMethod): boolean {
  return authMethod === "oauth-personal" || authMethod === "oauth-business";
}

/** Label shown on the provider card once the method has authenticated. */
export function antigravityAuthLabel(authMethod: AntigravityAuthMethod): string {
  switch (authMethod) {
    case "oauth-personal":
      return "Google account";
    case "oauth-business":
      return "Gemini Enterprise";
    case "gemini-api-key":
      return "Gemini API key";
    case "agent-platform":
      return "Agent Platform";
  }
}

/**
 * Explains what is missing before a non-personal method can authenticate, or
 * null when the config is complete. Personal sign-in never needs config.
 */
export function antigravityAuthConfigIssue(auth: AntigravityAuthConfig): string | null {
  switch (auth.authMethod) {
    case "oauth-personal":
      return null;
    case "oauth-business":
      return auth.gcpProject && auth.gcpLocation
        ? null
        : "Gemini Enterprise needs a GCP project and location in the Antigravity provider settings.";
    case "gemini-api-key":
      return auth.apiKey ? null : "Enter a Gemini API key in the Antigravity provider settings.";
    case "agent-platform":
      return auth.apiKey || (auth.gcpProject && auth.gcpLocation)
        ? null
        : "Agent Platform needs an API key, or a GCP project and location, in the Antigravity provider settings.";
  }
}

/**
 * `settings.json` content for the agent's profile. `auth.type` names the
 * selected method so a native logout clears only that method's credentials
 * instead of every stored token. The GCP block feeds Enterprise and Agent
 * Platform. Never holds a credential.
 */
export function antigravityProfileSettings(auth: AntigravityAuthConfig): string {
  const gcp = {
    ...(auth.gcpProject ? { project: auth.gcpProject } : {}),
    ...(auth.gcpLocation ? { location: auth.gcpLocation } : {}),
  };
  return `${encodeProfileSettings({
    auth: { type: auth.authMethod },
    ...(Object.keys(gcp).length > 0 ? { gcp } : {}),
  })}\n`;
}

export interface AntigravityAuthorizationUrl {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
}

function authSupportError(detail: string) {
  return new AcpErrors.AcpTransportError({ detail, cause: undefined });
}

/** Recognizes native auth failures and interactive login blocked by T3. */
export function isAntigravitySignInRequiredError(error: unknown): boolean {
  return (
    (isAcpRequestError(error) && error.code === -32000) ||
    (isAcpTransportError(error) && error.detail === ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)
  );
}

/** Keeps case-sensitive instance IDs separate on case-insensitive filesystems. */
export function resolveAntigravityProfileDirectory(
  stateDir: string,
  instanceId: ProviderInstanceId,
): string {
  const directoryName = NodeCrypto.createHash("sha256").update(instanceId).digest("hex");
  return NodePath.join(stateDir, "providers", "antigravity", directoryName);
}

function quoteBrowserArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Sign-in launches route the browser through the preload, and only they carry
 * NODE_OPTIONS so turn subprocesses never inherit it. Other launches keep a
 * BROWSER value Python cannot run, so no browser opens.
 */
function antigravityEnvironment(
  profile: AntigravityProfile,
  baseEnv: NodeJS.ProcessEnv,
  auth: AntigravityAuthConfig,
  signIn?: { readonly authorizationUrlSink?: string },
) {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    // Windows treats environment keys as case-insensitive. Remove aliases too.
    if (!removedEnvironmentKeys.has(key.toUpperCase())) environment[key] = value;
  }
  const browser = signIn
    ? {
        BROWSER: profile.browserHelperPath,
        // Node reads backslashes inside quoted NODE_OPTIONS values as escapes.
        NODE_OPTIONS: [
          environment.NODE_OPTIONS,
          `--require "${profile.browserPreloadPath.replaceAll("\\", "/")}"`,
        ]
          .filter((value) => value)
          .join(" "),
        ...(signIn.authorizationUrlSink
          ? { [ANTIGRAVITY_AUTH_SINK_ENV]: signIn.authorizationUrlSink }
          : {}),
      }
    : { BROWSER: profile.browserCommand };
  // Only the configured method's credential reaches the agent. The agent
  // prefers GOOGLE_API_KEY over the GCP pair for Agent Platform, so the pair
  // goes through settings.json instead of the environment.
  const credential =
    auth.authMethod === "gemini-api-key" && auth.apiKey
      ? { GEMINI_API_KEY: auth.apiKey }
      : auth.authMethod === "agent-platform" && auth.apiKey
        ? { GOOGLE_API_KEY: auth.apiKey }
        : {};
  return {
    ...environment,
    ...credential,
    GEMINI_HOME: profile.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    ...browser,
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
  };
}

/** Prepares a private profile without reading or copying Google credentials. */
export const prepareAntigravityProfile = Effect.fn("prepareAntigravityProfile")(function* (input: {
  readonly profileDirectory: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly runtimeExecutablePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly auth?: AntigravityAuthConfig;
}) {
  const auth = input.auth ?? ANTIGRAVITY_PERSONAL_AUTH;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = input.platform ?? (yield* HostProcessPlatform);
  const runtimeExecutablePath = input.runtimeExecutablePath ?? (yield* HostProcessExecutablePath);
  const helperExecutable =
    platform === "win32" ? runtimeExecutablePath.replaceAll("\\", "/") : runtimeExecutablePath;
  const browserArguments = [helperExecutable, "-e", browserHelperSource, "--", "%s"];
  const browserCommand = browserArguments.map(quoteBrowserArgument).join(" ");
  if (
    browserCommand.includes(platform === "win32" ? ";" : ":") ||
    helperExecutable.includes("\r") ||
    helperExecutable.includes("\n") ||
    helperExecutable.includes("\0") ||
    helperExecutable.includes("%s")
  ) {
    return yield* authSupportError(
      "The T3 runtime path cannot be used to suppress Antigravity browser launches.",
    );
  }

  const geminiHome = path.resolve(input.profileDirectory);
  const acpDirectory = path.join(geminiHome, "antigravity-acp");
  const browserPreloadPath = path.join(acpDirectory, browserPreloadFileName);
  if (browserPreloadPath.includes('"')) {
    return yield* authSupportError(
      "The Antigravity profile path cannot be used to suppress browser launches.",
    );
  }
  const profile: AntigravityProfile = {
    platform,
    geminiHome,
    acpDirectory,
    tokenPath: path.join(acpDirectory, "acp_token.json"),
    browserCommand,
    browserHelperPath: helperExecutable,
    browserPreloadPath,
  };
  for (const directory of [geminiHome, acpDirectory]) {
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(() =>
          authSupportError("The Antigravity profile directory could not be created."),
        ),
      );
    if (platform !== "win32") {
      yield* fs
        .chmod(directory, 0o700)
        .pipe(
          Effect.mapError(() =>
            authSupportError("The Antigravity profile directory permissions could not be set."),
          ),
        );
    }
  }
  yield* fs
    .writeFileString(browserPreloadPath, browserPreloadSource)
    .pipe(
      Effect.mapError(() =>
        authSupportError("The Antigravity browser preload could not be written."),
      ),
    );
  const environment = antigravityEnvironment(profile, input.baseEnv ?? process.env, auth, {});
  yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(helperExecutable, [browserPreflightUrl], {
        env: environment,
        extendEnv: false,
        shell: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 4_096 }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: 4_096 }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (
      Number(exitCode) !== 0 ||
      stdout.bytes !== 0 ||
      stdout.truncated ||
      stderr.truncated ||
      stderr.text !== `${ANTIGRAVITY_AUTH_BROWSER_MARKER}"${browserPreflightUrl}"\n`
    ) {
      return yield* authSupportError("Antigravity browser suppression could not be verified.");
    }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(authSupportError("Antigravity browser suppression verification timed out.")),
    }),
    Effect.mapError((error) =>
      error._tag === "AcpTransportError"
        ? error
        : authSupportError("Antigravity browser suppression could not be verified."),
    ),
  );

  // Rewriting on every launch keeps a method, project, or location edit in
  // Settings effective. The agent also records auth.type here after a
  // sign-in, which matches the value written below.
  yield* fs
    .writeFileString(path.join(acpDirectory, "settings.json"), antigravityProfileSettings(auth))
    .pipe(
      Effect.mapError(() =>
        authSupportError("The Antigravity profile settings could not be written."),
      ),
    );
  return profile;
});

/** Applies the same subscription-only launch settings to every ACP process. */
export function buildAntigravityAcpSpawnInput(input: {
  readonly installation: {
    readonly executablePath: string;
    readonly harnessPath: string;
  };
  readonly profile: AntigravityProfile;
  readonly cwd: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly auth?: AntigravityAuthConfig;
  /** Present only for the sign-in launch. See `serveAntigravityAuthorizationUrlSink`. */
  readonly authorizationUrlSink?: string;
}): AcpSpawnInput {
  return {
    command: input.installation.executablePath,
    args: input.profile.platform === "linux" ? ["--uid="] : [],
    cwd: input.cwd,
    env: {
      ...antigravityEnvironment(
        input.profile,
        input.baseEnv ?? process.env,
        input.auth ?? ANTIGRAVITY_PERSONAL_AUTH,
        input.authorizationUrlSink
          ? { authorizationUrlSink: input.authorizationUrlSink }
          : undefined,
      ),
      ANTIGRAVITY_HARNESS_PATH: input.installation.harnessPath,
    },
    extendEnv: false,
  };
}

/** Reads only the public authorization request, never an OAuth token file. */
export const parseAntigravityAuthorizationUrl = Effect.fn("parseAntigravityAuthorizationUrl")(
  function* (
    authorizationUrl: string,
  ): Effect.fn.Return<AntigravityAuthorizationUrl, AcpErrors.AcpError> {
    const invalidUrl = () =>
      authSupportError("Antigravity returned an invalid Google sign-in URL.");
    if (authorizationUrl.length > maxAuthorizationUrlLength || /\s/.test(authorizationUrl)) {
      return yield* invalidUrl();
    }
    const url = yield* decodeUrl(authorizationUrl).pipe(Effect.mapError(invalidUrl));
    const state = url.searchParams.get("state");
    const redirectUri = url.searchParams.get("redirect_uri");
    if (
      url.origin !== "https://accounts.google.com" ||
      url.pathname !== "/o/oauth2/v2/auth" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("redirect_uri").length !== 1 ||
      url.searchParams.getAll("response_type").length !== 1 ||
      url.searchParams.get("response_type") !== "code" ||
      state === null ||
      state.length === 0 ||
      state.length > 512 ||
      /\s/.test(state) ||
      redirectUri === null ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
    ) {
      return yield* invalidUrl();
    }
    const redirect = yield* decodeUrl(redirectUri).pipe(Effect.mapError(invalidUrl));
    if (Number(redirect.port) < 1_024) return yield* invalidUrl();
    return { authorizationUrl, redirectUri, state };
  },
);

export function makeAntigravityStdoutTransform(
  input: {
    readonly onAuthorizationUrl?: (
      authorizationUrl: string,
    ) => Effect.Effect<void, AcpErrors.AcpError>;
  } = {},
) {
  const handleLine = Effect.fn("antigravityAuthSupport.handleStdoutLine")(function* (
    line: Uint8Array,
  ) {
    if (!authPrefixBytes.every((byte, index) => line[index] === byte)) return [line];
    const message = new TextDecoder().decode(line).replace(/\r?\n$/, "");
    const request = yield* parseAntigravityAuthorizationUrl(
      message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length),
    );
    if (!input.onAuthorizationUrl) {
      return yield* authSupportError(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE);
    }
    yield* input.onAuthorizationUrl(request.authorizationUrl);
    return [];
  });

  return (
    stdout: ChildProcessSpawner.ChildProcessHandle["stdout"],
  ): Stream.Stream<Uint8Array, PlatformError.PlatformError | AcpErrors.AcpError> =>
    Stream.suspend(() => {
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      const finishLine = () => {
        const line = Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        return line;
      };
      return stdout.pipe(
        Stream.mapEffect(
          Effect.fn("antigravityAuthSupport.splitStdoutLines")(function* (chunk: Uint8Array) {
            const lines: Uint8Array[] = [];
            let offset = 0;
            while (offset < chunk.byteLength) {
              const newline = chunk.indexOf(10, offset);
              const end = newline === -1 ? chunk.byteLength : newline + 1;
              const part = chunk.subarray(offset, end);
              if (pendingBytes + part.byteLength > maxStdoutLineBytes) {
                return yield* authSupportError(
                  "Antigravity sent a protocol line that is too large.",
                );
              }
              pending.push(part);
              pendingBytes += part.byteLength;
              if (newline !== -1) lines.push(finishLine());
              offset = end;
            }
            return lines;
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
        Stream.concat(
          Stream.suspend(() => (pendingBytes > 0 ? Stream.succeed(finishLine()) : Stream.empty)),
        ),
        Stream.mapEffect(handleLine),
        Stream.flatMap(Stream.fromIterable),
      );
    });
}

/** Receives native 1.1.1 sign-in URLs and T3 browser-helper URLs without logging stderr. */
export function makeAntigravityStderrHandler(
  input: {
    readonly onAuthorizationUrl?: (
      authorizationUrl: string,
    ) => Effect.Effect<void, AcpErrors.AcpError>;
  } = {},
) {
  let pending = "";
  const handleLine = (line: string) => {
    const message = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (message.length > maxBrowserHelperLineLength) {
      return Effect.void;
    }
    const url = message.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)
      ? Effect.succeed(message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length))
      : message.startsWith(ANTIGRAVITY_AUTH_BROWSER_MARKER)
        ? decodeBrowserHelperUrl(message.slice(ANTIGRAVITY_AUTH_BROWSER_MARKER.length))
        : undefined;
    if (url === undefined) return Effect.void;
    return url.pipe(
      Effect.flatMap(parseAntigravityAuthorizationUrl),
      Effect.matchEffect({
        onFailure: () => Effect.void,
        onSuccess: (request) =>
          input.onAuthorizationUrl
            ? input.onAuthorizationUrl(request.authorizationUrl)
            : Effect.fail(authSupportError(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)),
      }),
    );
  };

  return Effect.fn("antigravityAuthSupport.handleStderr")(function* (text: string) {
    const lines = `${pending}${text}`.split("\n");
    pending = lines.pop() ?? "";
    if (pending.length > maxBrowserHelperLineLength) pending = "";
    yield* Effect.forEach(lines, handleLine, { discard: true });
  });
}

/**
 * Serves the loopback endpoint the browser preload posts the sign-in URL to.
 * The agent's own stdout copy of the URL never leaves its buffer until exit,
 * so this is how sign-in learns the URL. Lives for the sign-in scope.
 */
export const serveAntigravityAuthorizationUrlSink = Effect.fn(
  "serveAntigravityAuthorizationUrlSink",
)(function* (
  onAuthorizationUrl: (url: string) => Effect.Effect<void, AcpErrors.AcpError>,
): Effect.fn.Return<string, AcpErrors.AcpError, Scope.Scope> {
  const token = NodeCrypto.randomBytes(16).toString("hex");
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const server = NodeHttp.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== `/${token}`) {
      response.statusCode = 404;
      response.end();
      request.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxAuthorizationUrlLength) {
        response.statusCode = 413;
        response.end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      response.statusCode = 204;
      response.end();
      runFork(onAuthorizationUrl(Buffer.concat(chunks).toString("utf8")).pipe(Effect.ignore));
    });
  });
  yield* Effect.acquireRelease(
    Effect.callback<void, AcpErrors.AcpError>((resume) => {
      server.once("error", () =>
        resume(authSupportError("The Antigravity sign-in listener could not start.")),
      );
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* authSupportError("The Antigravity sign-in listener could not start.");
  }
  return `http://127.0.0.1:${address.port}/${token}`;
});
