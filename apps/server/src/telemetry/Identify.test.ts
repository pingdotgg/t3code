import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const sha256 = Effect.fn("test.sha256")(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.orDie),
  );
});

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const findIdentityLog = (
  logs: ReadonlyArray<CapturedLog>,
  source: Identify.TelemetryIdentitySource,
  errorTag: string,
) => logs.find((log) => log.annotations.source === source && log.annotations.errorTag === errorTag);

const unsignedJwt = (claims: Readonly<Record<string, unknown>>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");

const layerIdentity = (prefix: string, logs?: CapturedLog[]) =>
  Layer.provideMerge(
    ServerSecretStore.layer,
    ServerConfig.layerTest(process.cwd(), { prefix }),
  ).pipe(
    Layer.merge(
      logs === undefined
        ? Layer.empty
        : Logger.layer([makeCaptureLogger(logs)], { mergeWithExisting: false }),
    ),
  );

const writeHomeFile = Effect.fn("test.writeHomeFile")(function* (
  homeDirectory: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(homeDirectory, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
  return filePath;
});

it.layer(NodeServices.layer)("telemetry identity", (it) => {
  it.effect("keeps the old distinct_id rule and a fixed install id as logins change", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");
      const anonymousId = "persisted-anonymous-id";
      yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);
      const installId = yield* sha256(anonymousId);
      const identity = () => Identify.getTelemetryIdentityForHome(homeDirectory);

      assert.deepEqual(yield* identity(), { distinctId: installId, installId });

      yield* writeHomeFile(homeDirectory, ".claude.json", `{"userID":"claude-machine"}`);
      assert.deepEqual(yield* identity(), {
        distinctId: yield* sha256("claude-machine"),
        installId,
      });

      yield* writeHomeFile(homeDirectory, ".codex/auth.json", `{"auth_mode":"apikey"}`);
      assert.equal((yield* identity()).distinctId, yield* sha256("claude-machine"));

      yield* writeHomeFile(homeDirectory, ".codex/auth.json", `{"tokens":{"account_id":"ws-1"}}`);
      assert.deepEqual(yield* identity(), { distinctId: yield* sha256("ws-1"), installId });
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-install-"))),
  );

  it.effect("leaves no torn anonymous id behind when its write fails midway", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tornWrites = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (filePath, data, options) =>
          fileSystem
            .writeFileString(filePath, data.slice(0, Math.floor(data.length / 2)), options)
            .pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "WriteZero",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: filePath,
                  }),
                ),
              ),
            ),
      });

      const identity = yield* Identify.getTelemetryIdentityForHome(
        path.join(config.baseDir, "home"),
      ).pipe(Effect.provideService(FileSystem.FileSystem, tornWrites));

      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-torn-"))),
  );

  it.effect("does not overwrite the anonymous id path after a non-NotFound read failure", () => {
    const logs: CapturedLog[] = [];

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(config.anonymousIdPath);

      const identity = yield* Identify.getTelemetryIdentityForHome(
        path.join(config.baseDir, "home"),
      );
      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.deepEqual(yield* fileSystem.readDirectory(config.anonymousIdPath), []);

      const readLog = findIdentityLog(logs, "anonymous", "TelemetryIdentityReadError");
      assert.equal(readLog?.annotations.filePath, config.anonymousIdPath);
      assert.notEqual(readLog?.annotations.platformReason, "NotFound");
      assert.notProperty(readLog?.annotations ?? {}, "cause");
      assert.isUndefined(
        findIdentityLog(logs, "anonymous", "TelemetryAnonymousIdPersistenceError"),
      );
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-read-", logs)));
  });

  it.effect("reads the Connect account and each provider account as owners", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");
      yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("user_connect"));
      yield* writeHomeFile(
        homeDirectory,
        ".codex/auth.json",
        JSON.stringify({
          tokens: {
            account_id: "team-workspace",
            id_token: unsignedJwt({
              sub: "google-oauth2|login-method",
              "https://api.openai.com/auth": { user_id: "user-openai-person" },
            }),
          },
        }),
      );
      yield* writeHomeFile(
        homeDirectory,
        ".claude.json",
        JSON.stringify({
          userID: "claude-machine",
          oauthAccount: { accountUuid: "claude-person" },
        }),
      );

      const owners = yield* Identify.getServerOwnersForHome(homeDirectory);

      assert.deepEqual(owners, [
        { source: "connect", ownerId: yield* sha256("user_connect") },
        { source: "openai", ownerId: yield* sha256("user-openai-person") },
        { source: "claude", ownerId: yield* sha256("claude-person") },
      ]);
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-owners-"))),
  );

  it.effect.each([
    {
      login: "an API key",
      secret: "sk-private-openai-api-key",
      authJson: (secret: string) => `{"auth_mode":"apikey","OPENAI_API_KEY":"${secret}"}`,
    },
    {
      login: "an agent identity",
      secret: "private-agent-identity-jwt",
      authJson: (secret: string) =>
        `{"auth_mode":"agentIdentity","OPENAI_API_KEY":null,"agent_identity":"${secret}"}`,
    },
    {
      login: "a personal access token",
      secret: "private-personal-access-token",
      authJson: (secret: string) => `{"OPENAI_API_KEY":null,"personal_access_token":"${secret}"}`,
    },
  ])(
    "adds no owner and logs nothing when Codex authenticates with $login",
    ({ secret, authJson }) => {
      const logs: CapturedLog[] = [];

      return Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const homeDirectory = path.join(config.baseDir, "home");
        yield* writeHomeFile(homeDirectory, ".codex/auth.json", authJson(secret));

        assert.deepEqual(yield* Identify.getServerOwnersForHome(homeDirectory), []);
        assert.deepEqual(logs, []);
      }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-tokenless-", logs)));
    },
  );

  it.effect(
    "warns about malformed Codex auth without its tokens and keeps the other owners",
    () => {
      const logs: CapturedLog[] = [];

      return Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const homeDirectory = path.join(config.baseDir, "home");
        const privateAccessToken = "private-codex-access-token";
        const codexAuthPath = yield* writeHomeFile(
          homeDirectory,
          ".codex/auth.json",
          `{"tokens":{"access_token":"${privateAccessToken}"}}`,
        );
        yield* writeHomeFile(
          homeDirectory,
          ".claude.json",
          `{"oauthAccount":{"accountUuid":"claude-person"}}`,
        );

        assert.deepEqual(yield* Identify.getServerOwnersForHome(homeDirectory), [
          { source: "claude", ownerId: yield* sha256("claude-person") },
        ]);
        const decodeLog = findIdentityLog(logs, "codex", "TelemetryIdentityDecodeError");
        assert.equal(
          decodeLog?.message,
          `Failed to decode codex telemetry identity at '${codexAuthPath}'.`,
        );
        assert.equal(decodeLog?.annotations.causeKind, "schema");
        assert.notInclude(
          Object.values(decodeLog?.annotations ?? {})
            .map(String)
            .join("\n"),
          privateAccessToken,
        );
      }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-decode-", logs)));
    },
  );
});
