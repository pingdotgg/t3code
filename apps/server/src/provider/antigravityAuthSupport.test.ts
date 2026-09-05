// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";

import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  ANTIGRAVITY_PERSONAL_AUTH,
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  type AntigravityAuthConfig,
  antigravityAuthConfigIssue,
  type AntigravityProfile,
  antigravityProfileSettings,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  makeAntigravityStderrHandler,
  makeAntigravityStdoutTransform,
  parseAntigravityAuthorizationUrl,
  prepareAntigravityProfile,
  resolveAntigravityProfileDirectory,
} from "./antigravityAuthSupport.ts";

const authorizationUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code" +
  "&client_id=test-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A46353%2F" +
  "&state=test-opaque-state&code_challenge=test-challenge&code_challenge_method=S256";
const authLine = `${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${authorizationUrl}\n`;
const encode = (text: string) => new TextEncoder().encode(text);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("Antigravity process environment", () => {
  const profile: AntigravityProfile = {
    platform: "linux",
    geminiHome: "/t3/userdata/providers/antigravity/profile",
    acpDirectory: "/t3/userdata/providers/antigravity/profile/antigravity-acp",
    tokenPath: "/t3/userdata/providers/antigravity/profile/antigravity-acp/acp_token.json",
    browserCommand: "managed-browser-helper",
  };

  it("isolates the profile and harness after merging overrides without changing the base environment", () => {
    const baseEnv = {
      HOME: "/home/developer",
      PATH: "/usr/bin",
      GEMINI_API_KEY: "do-not-use-api-billing",
      google_api_key: "case-insensitive-api-key",
      GOOGLE_CLOUD_PROJECT: "do-not-use-project",
      GOOGLE_CLOUD_LOCATION: "do-not-use-location",
      GOOGLE_APPLICATION_CREDENTIALS: "/credentials.json",
      GOOGLE_CLOUD_QUOTA_PROJECT: "do-not-use-quota-project",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      AGY_ACP_CCPA_PROJECT: "do-not-use-consumer-project",
      AGY_ACP_ENABLE_OAUTH: "1",
      GEMINI_HOME: "/shared-gemini-home",
      gemini_home: "/alias-shared-home",
      AGY_ACP_FORCE_FILE_STORAGE: "0",
      ANTIGRAVITY_HARNESS_PATH: "/wrong-version/harness",
      BROWSER: "open-real-browser",
      browser: "another-real-browser",
      PYTHONUNBUFFERED: "0",
      ELECTRON_RUN_AS_NODE: "0",
      CUSTOM_SETTING: "keep-this",
    };
    const original = { ...baseEnv };
    const spawn = buildAntigravityAcpSpawnInput({
      installation: { executablePath: "/release/acp", harnessPath: "/release/harness" },
      profile,
      cwd: "/project",
      baseEnv,
    });

    expect(baseEnv).toEqual(original);
    expect(spawn).toEqual({
      command: "/release/acp",
      args: ["--uid="],
      cwd: "/project",
      extendEnv: false,
      env: {
        HOME: "/home/developer",
        PATH: "/usr/bin",
        CUSTOM_SETTING: "keep-this",
        GEMINI_HOME: profile.geminiHome,
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        ANTIGRAVITY_HARNESS_PATH: "/release/harness",
        BROWSER: profile.browserCommand,
        PYTHONUNBUFFERED: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
  });

  it("passes only the configured method's credential and keeps the GCP pair out of the environment", () => {
    const baseEnv = { PATH: "/usr/bin", GOOGLE_API_KEY: "ambient-key" };
    const spawnFor = (auth: AntigravityAuthConfig) =>
      buildAntigravityAcpSpawnInput({
        installation: { executablePath: "/release/acp", harnessPath: "/release/harness" },
        profile,
        cwd: "/project",
        baseEnv,
        auth,
      }).env ?? {};

    const geminiKey = spawnFor({
      authMethod: "gemini-api-key",
      apiKey: "gemini-secret",
      gcpProject: "proj",
      gcpLocation: "us-central1",
    });
    expect(geminiKey.GEMINI_API_KEY).toBe("gemini-secret");
    expect(geminiKey.GOOGLE_API_KEY).toBeUndefined();
    expect(geminiKey.GOOGLE_CLOUD_PROJECT).toBeUndefined();

    const vertexKey = spawnFor({
      authMethod: "agent-platform",
      apiKey: "vertex-secret",
      gcpProject: "",
      gcpLocation: "",
    });
    expect(vertexKey.GOOGLE_API_KEY).toBe("vertex-secret");
    expect(vertexKey.GEMINI_API_KEY).toBeUndefined();

    const business = spawnFor({
      authMethod: "oauth-business",
      apiKey: "ignored",
      gcpProject: "proj",
      gcpLocation: "us-central1",
    });
    expect(business.GEMINI_API_KEY).toBeUndefined();
    expect(business.GOOGLE_API_KEY).toBeUndefined();
  });

  it("writes the auth method and GCP block into the agent's settings.json", () => {
    expect(
      decodeJson(
        antigravityProfileSettings({
          authMethod: "oauth-business",
          apiKey: "never-written",
          gcpProject: "proj",
          gcpLocation: "us-central1",
        }),
      ),
    ).toEqual({
      auth: { type: "oauth-business" },
      gcp: { project: "proj", location: "us-central1" },
    });
    // The agent's logout reads auth.type to clear only that method's token.
    expect(decodeJson(antigravityProfileSettings(ANTIGRAVITY_PERSONAL_AUTH))).toEqual({
      auth: { type: "oauth-personal" },
    });
  });

  it("names the missing credential for each method", () => {
    expect(antigravityAuthConfigIssue(ANTIGRAVITY_PERSONAL_AUTH)).toBeNull();
    expect(
      antigravityAuthConfigIssue({ ...ANTIGRAVITY_PERSONAL_AUTH, authMethod: "gemini-api-key" }),
    ).toContain("API key");
    expect(
      antigravityAuthConfigIssue({
        ...ANTIGRAVITY_PERSONAL_AUTH,
        authMethod: "oauth-business",
        gcpProject: "proj",
      }),
    ).toContain("location");
    expect(
      antigravityAuthConfigIssue({
        ...ANTIGRAVITY_PERSONAL_AUTH,
        authMethod: "agent-platform",
        gcpProject: "proj",
        gcpLocation: "us-central1",
      }),
    ).toBeNull();
  });

  it("uses the registry launch arguments for each supported host platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const spawn = buildAntigravityAcpSpawnInput({
        installation: { executablePath: "/release/acp", harnessPath: "/release/harness" },
        profile: { ...profile, platform },
        cwd: "/project",
        baseEnv: {},
      });
      expect(spawn.args).toEqual(platform === "linux" ? ["--uid="] : []);
    }
  });

  it("keeps accounts separate even when instance IDs differ only by case", () => {
    const first = resolveAntigravityProfileDirectory(
      "/userdata",
      ProviderInstanceId.make("antigravity"),
    );
    const second = resolveAntigravityProfileDirectory(
      "/userdata",
      ProviderInstanceId.make("Antigravity"),
    );
    expect(first.toLowerCase()).not.toBe(second.toLowerCase());
    expect(
      resolveAntigravityProfileDirectory("/userdata", ProviderInstanceId.make("antigravity")),
    ).toBe(first);
  });
});

describe("Antigravity authorization URL", () => {
  it.effect("returns the official Google URL and its owned loopback target", () =>
    Effect.gen(function* () {
      expect(yield* parseAntigravityAuthorizationUrl(authorizationUrl)).toEqual({
        authorizationUrl,
        redirectUri: "http://127.0.0.1:46353/",
        state: "test-opaque-state",
      });
    }),
  );

  it.effect(
    "rejects other origins, ambiguous state, and non-loopback redirects without retaining them",
    () =>
      Effect.gen(function* () {
        const invalidUrls = [
          authorizationUrl.replace("https:", "http:"),
          authorizationUrl.replace("accounts.google.com", "accounts.google.com.example.invalid"),
          authorizationUrl.replace("accounts.google.com", "secret@accounts.google.com"),
          authorizationUrl.replace("/o/oauth2/v2/auth", "/another-path"),
          `${authorizationUrl}#secret-fragment`,
          `${authorizationUrl}&state=another-state`,
          authorizationUrl.replace("test-opaque-state", ""),
          authorizationUrl.replace("test-opaque-state", "opaque%0astate"),
          authorizationUrl.replace("127.0.0.1", "localhost"),
          authorizationUrl.replace("127.0.0.1", "169.254.169.254"),
          authorizationUrl.replace("46353", "80"),
          authorizationUrl.replace("46353", "70000"),
          authorizationUrl.replace("46353%2F", "46353%2Fother"),
          authorizationUrl.replace("response_type=code", "response_type=token"),
          "not a URL containing secret-code",
        ];
        for (const invalidUrl of invalidUrls) {
          const result = yield* parseAntigravityAuthorizationUrl(invalidUrl).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isSuccess(result)) continue;
          expect(result.failure._tag).toBe("AcpTransportError");
          expect(encodeUnknownJson(result.failure)).not.toContain("test-opaque-state");
          expect(encodeUnknownJson(result.failure)).not.toContain("secret-code");
          expect(encodeUnknownJson(result.failure)).not.toContain(invalidUrl);
        }
      }),
  );
});

describe("Antigravity sign-in errors", () => {
  it("recognizes native auth-required errors and the blocked-login transport error", () => {
    expect(isAntigravitySignInRequiredError(AcpErrors.AcpRequestError.authRequired())).toBe(true);
    expect(
      isAntigravitySignInRequiredError(
        new AcpErrors.AcpTransportError({
          detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
          cause: undefined,
        }),
      ),
    ).toBe(true);
  });

  it("does not treat other failures or arbitrary text as missing authentication", () => {
    const otherErrors = [
      new AcpErrors.AcpTransportError({ detail: "The process stopped.", cause: undefined }),
      AcpErrors.AcpRequestError.internalError(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE),
      new Error(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE),
      { detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE },
      ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
      undefined,
    ];
    for (const error of otherErrors) expect(isAntigravitySignInRequiredError(error)).toBe(false);
  });
});

describe("Antigravity stdout compatibility", () => {
  it.effect(
    "handles fragmented login lines between JSON messages without changing protocol bytes",
    () =>
      Effect.gen(function* () {
        const urls: string[] = [];
        const jsonBefore = '{"jsonrpc":"2.0","id":1,"result":{}}\r\n';
        const jsonAfter = '{"jsonrpc":"2.0","id":2,"result":{"text":"café"}}\n';
        const chunks = [
          encode(`${jsonBefore}${ANTIGRAVITY_AUTH_STDOUT_PREFIX.slice(0, 7)}`),
          encode(ANTIGRAVITY_AUTH_STDOUT_PREFIX.slice(7)),
          encode(authorizationUrl.slice(0, 40)),
          encode(`${authorizationUrl.slice(40)}\r`),
          encode(`\n${jsonAfter}`),
        ];
        const result = yield* makeAntigravityStdoutTransform({
          onAuthorizationUrl: (url) => Effect.sync(() => void urls.push(url)),
        })(Stream.fromIterable(chunks)).pipe(Stream.decodeText(), Stream.mkString);
        expect(result).toBe(`${jsonBefore}${jsonAfter}`);
        expect(urls).toEqual([authorizationUrl]);
      }),
  );

  it.effect("handles an auth line without a final newline", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const result = yield* makeAntigravityStdoutTransform({
        onAuthorizationUrl: (url) => Effect.sync(() => void urls.push(url)),
      })(Stream.make(encode(authLine.slice(0, -1)))).pipe(Stream.runCollect);
      expect(result).toEqual([]);
      expect(urls).toEqual([authorizationUrl]);
    }),
  );

  it.effect("ends normal work with a safe sign-in error instead of waiting for OAuth", () =>
    Effect.gen(function* () {
      const result = yield* makeAntigravityStdoutTransform()(Stream.make(encode(authLine))).pipe(
        Stream.runDrain,
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({
        _tag: "AcpTransportError",
        detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
      });
      expect(encodeUnknownJson(result.failure)).not.toContain(authorizationUrl);
      expect(encodeUnknownJson(result.failure)).not.toContain("test-opaque-state");
    }),
  );

  it.effect("preserves typed errors from the flow owner", () =>
    Effect.gen(function* () {
      const failure = new AcpErrors.AcpTransportError({
        detail: "This sign-in flow has expired.",
        cause: undefined,
      });
      const result = yield* makeAntigravityStdoutTransform({
        onAuthorizationUrl: () => Effect.fail(failure),
      })(Stream.make(encode(authLine))).pipe(Stream.runDrain, Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toBe(failure);
    }),
  );

  it.effect("does not suppress malformed protocol data or similar login messages", () =>
    Effect.gen(function* () {
      const unrelated = [
        "this is not JSON\n",
        `${ANTIGRAVITY_AUTH_STDOUT_PREFIX.toLowerCase()}${authorizationUrl}\n`,
        ` ${authLine}`,
      ];
      for (const line of unrelated) {
        const transform = makeAntigravityStdoutTransform();
        const output = yield* transform(Stream.make(encode(line))).pipe(
          Stream.decodeText(),
          Stream.mkString,
        );
        expect(output).toBe(line);
        const decoded = yield* transform(Stream.make(encode(line))).pipe(
          Stream.pipeThroughChannel(Ndjson.decode()),
          Stream.runDrain,
          Effect.result,
        );
        expect(Result.isFailure(decoded)).toBe(true);
      }
    }),
  );

  it.effect("bounds unfinished protocol lines", () =>
    Effect.gen(function* () {
      const result = yield* makeAntigravityStdoutTransform()(
        Stream.make(new Uint8Array(16 * 1024 * 1024), encode("x")),
      ).pipe(Stream.runDrain, Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({
        _tag: "AcpTransportError",
        detail: "Antigravity sent a protocol line that is too large.",
      });
    }),
  );
});

describe("Antigravity stderr compatibility", () => {
  it.effect("forwards fragmented native sign-in URLs from runtime 1.1.1", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const line = `${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${authorizationUrl}\r\n`;
      const handleStderr = makeAntigravityStderrHandler({
        onAuthorizationUrl: (url) => Effect.sync(() => void urls.push(url)),
      });
      yield* handleStderr(`native log\n${line.slice(0, 40)}`);
      yield* handleStderr(line.slice(40, 90));
      yield* handleStderr(`${line.slice(90)}another native log\n`);
      expect(urls).toEqual([authorizationUrl]);
    }),
  );

  it.effect("rejects interactive sign-in during normal work", () =>
    Effect.gen(function* () {
      const handleStderr = makeAntigravityStderrHandler();
      const error = yield* handleStderr(
        `${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${authorizationUrl}\n`,
      ).pipe(Effect.flip);
      expect(isAntigravitySignInRequiredError(error)).toBe(true);
    }),
  );

  it.effect("preserves failures from the sign-in flow owner", () =>
    Effect.gen(function* () {
      const failure = new AcpErrors.AcpTransportError({
        detail: "The sign-in flow stopped.",
        cause: undefined,
      });
      const handleStderr = makeAntigravityStderrHandler({
        onAuthorizationUrl: () => Effect.fail(failure),
      });
      const error = yield* handleStderr(
        `${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${authorizationUrl}\n`,
      ).pipe(Effect.flip);
      expect(error).toBe(failure);
    }),
  );

  it.effect("forwards an accepted browser-helper URL larger than 8 KiB", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const longAuthorizationUrl = `${authorizationUrl}&scope=${"a".repeat(9_000)}`;
      const handleStderr = makeAntigravityStderrHandler({
        onAuthorizationUrl: (url) => Effect.sync(() => void urls.push(url)),
      });

      expect(longAuthorizationUrl.length).toBeGreaterThan(8_192);
      yield* handleStderr(
        `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${encodeUnknownJson(longAuthorizationUrl)}\n`,
      );

      expect(urls).toEqual([longAuthorizationUrl]);
    }),
  );

  it.effect("forwards a fragmented browser-helper URL without exposing other stderr", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const markerLine = `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${encodeUnknownJson(authorizationUrl)}\n`;
      const handleStderr = makeAntigravityStderrHandler({
        onAuthorizationUrl: (url) => Effect.sync(() => void urls.push(url)),
      });

      yield* handleStderr(`native log\n${markerLine.slice(0, 12)}`);
      yield* handleStderr(markerLine.slice(12, 70));
      yield* handleStderr(`${markerLine.slice(70)}another native log\n`);

      expect(urls).toEqual([authorizationUrl]);
    }),
  );

  it.effect("ignores malformed and similar browser-helper messages", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const handleStderr = makeAntigravityStderrHandler({
        onAuthorizationUrl: (url) => Effect.sync(() => void urls.push(url)),
      });

      yield* handleStderr(
        ` ${ANTIGRAVITY_AUTH_BROWSER_MARKER}${encodeUnknownJson(authorizationUrl)}\n`,
      );
      yield* handleStderr(`${ANTIGRAVITY_AUTH_BROWSER_MARKER}${authorizationUrl}\n`);
      yield* handleStderr(
        `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${encodeUnknownJson("https://example.com")}\n`,
      );
      yield* handleStderr(`${ANTIGRAVITY_AUTH_STDOUT_PREFIX}https://example.com\n`);
      yield* handleStderr(` ${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${authorizationUrl}\n`);

      expect(urls).toEqual([]);
    }),
  );
});

it.layer(NodeServices.layer)("Antigravity profile preparation", (it) => {
  it.effect("preflights the no-browser helper and creates private directories only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped();
      const profile = yield* prepareAntigravityProfile({
        profileDirectory: path.join(temporaryDirectory, "profile"),
      });

      expect(profile.geminiHome).toBe(path.join(temporaryDirectory, "profile"));
      expect(yield* fs.exists(profile.acpDirectory)).toBe(true);
      expect(yield* fs.exists(profile.tokenPath)).toBe(false);
      if ((yield* HostProcessPlatform) !== "win32") {
        expect((yield* fs.stat(profile.geminiHome)).mode & 0o777).toBe(0o700);
        expect((yield* fs.stat(profile.acpDirectory)).mode & 0o777).toBe(0o700);
      }

      yield* fs.writeFileString(profile.tokenPath, "synthetic-token-fixture");
      yield* prepareAntigravityProfile({ profileDirectory: profile.geminiHome });
      expect(yield* fs.readFileString(profile.tokenPath)).toBe("synthetic-token-fixture");
    }),
  );

  it.effect("rewrites the GCP block on every launch and never stores the API key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped();
      const profile = yield* prepareAntigravityProfile({
        profileDirectory: temporaryDirectory,
        auth: {
          authMethod: "agent-platform",
          apiKey: "vertex-secret",
          gcpProject: "proj",
          gcpLocation: "us-central1",
        },
      });
      const settingsPath = path.join(profile.acpDirectory, "settings.json");
      const first = yield* fs.readFileString(settingsPath);
      expect(decodeJson(first)).toEqual({
        auth: { type: "agent-platform" },
        gcp: { project: "proj", location: "us-central1" },
      });
      expect(first).not.toContain("vertex-secret");

      yield* prepareAntigravityProfile({ profileDirectory: temporaryDirectory });
      expect(decodeJson(yield* fs.readFileString(settingsPath))).toEqual({
        auth: { type: "oauth-personal" },
      });
    }),
  );

  it.effect("keeps the browser helper successful when cancellation closes stderr", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped();
      let helperCommand: ChildProcess.StandardCommand | undefined;
      yield* prepareAntigravityProfile({ profileDirectory: temporaryDirectory }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (ChildProcess.isStandardCommand(command)) helperCommand = command;
            return spawner.spawn(command);
          }),
        ),
      );
      expect(helperCommand).toBeDefined();
      if (!helperCommand) return;
      const command = helperCommand;
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeChildProcess.spawn(command.command, command.args, {
            env: { ...command.options.env },
            stdio: ["ignore", "ignore", "pipe"],
          }),
        ),
        (process) => Effect.sync(() => void process.kill()),
      );
      child.stderr?.destroy();
      const exitCode = yield* Effect.promise(
        () =>
          new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
          }),
      );
      expect(exitCode).toBe(0);
    }),
  );

  it.effect("fails before creating a profile when the helper cannot start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped();
      const profileDirectory = path.join(temporaryDirectory, "unused-profile");
      const result = yield* prepareAntigravityProfile({
        profileDirectory,
        runtimeExecutablePath: path.join(temporaryDirectory, "missing-runtime"),
      }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(yield* fs.exists(profileDirectory)).toBe(false);
    }),
  );

  it.effect("rejects Python BROWSER delimiter collisions before starting a helper", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped();
      for (const platform of ["linux", "win32"] as const) {
        const profileDirectory = path.join(temporaryDirectory, platform);
        const result = yield* prepareAntigravityProfile({
          profileDirectory,
          platform,
          runtimeExecutablePath: platform === "win32" ? "C:/bad;path/node.exe" : "/bad:path/node",
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(yield* fs.exists(profileDirectory)).toBe(false);
      }
    }),
  );
});
