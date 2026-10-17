// @effect-diagnostics nodeBuiltinImport:off - Runs the actual configured auth command in separate Node processes.
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as CodexManagedTokenBroker from "../provider/CodexManagedTokenBroker.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import { makeCodexManagedRuntime } from "../provider/CodexManagedRuntime.ts";
import * as ProviderCredentialStore from "../provider/ProviderCredentialStore.ts";
import { codexAppServerArgs } from "../provider/codexLaunchArgs.ts";

const decodeSettings = Schema.decodeSync(CodexSettings);
const decodeCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Array(Schema.String)])),
);

it.live(
  "configured auth command reads the exact store, rotates once across processes, and rejects replaced or logged-out profiles",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const instanceId = ProviderInstanceId.make("codex-personal");
      const home = path.join(config.baseDir, "Codex home's space");
      const preload = path.join(config.baseDir, "oauth-mock.mjs");
      let renewals = 0;
      yield* fs.makeDirectory(home);
      // Helpers must remain transport-only and avoid the full CLI/auth/store graph.
      yield* fs.writeFileString(
        preload,
        `
      import { registerHooks } from 'node:module';
      if (process.env.ELECTRON_RUN_AS_NODE !== undefined) throw new Error('Node-hosted helper must not gain an Electron flag');
      registerHooks({ resolve(specifier, context, next) {
        if (['binCli', 'CodexChatGptAuth', 'ServerSecretStore', 'CodexManagedTokenBroker'].some(s => specifier.includes(s))) throw new Error('Server graph must not load');
        return next(specifier, context);
      } });
      globalThis.fetch = () => { throw new Error('Transport helper cannot use network'); };
    `,
      );
      yield* Effect.gen(function* () {
        const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
        const credentials = {
          clientId: "oaiapp_test",
          subject: "fake-subject",
          idToken: "fake-id-token",
          accessToken: "fake-initial-access",
          refreshToken: "fake-refresh",
          email: null,
          expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
          earliestRefreshAt: null,
          scopes: ["chatgpt.tokens.use.direct"],
        };
        const save = (record: typeof credentials) =>
          store.set(new TextEncoder().encode(JSON.stringify(record)));
        yield* save(credentials);
        const runtime = yield* makeCodexManagedRuntime({
          instanceId,
          enabled: true,
          config: decodeSettings({ setupMode: "managed", homePath: home }),
          environment: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            T3CODE_HOME: path.join(config.baseDir, "wrong-home"),
            ACCESS_TOKEN: "ambient-secret",
            OPENAI_BASE_URL: "https://wrong-endpoint.invalid",
            OPENAI_API_KEY: "ambient-key",
          },
        });
        const effective = yield* runtime.resolve;
        assert.isUndefined(effective.environment.ELECTRON_RUN_AS_NODE);
        const table = codexAppServerArgs(effective.config.launchArgs).find((arg) =>
          arg.startsWith("model_providers.openai_token_sharing_"),
        )!;
        const match = /auth=\{command=(.*),args=(\[.*\]),timeout_ms=/u.exec(table)!;
        const [command, args] = decodeCommand(`[${match[1]},${match[2]}]`);
        const broker = yield* CodexManagedTokenBroker.CodexManagedTokenBroker;
        assert.include(args, yield* broker.endpoint);
        assert.notInclude(args, config.secretsDir);
        for (const secret of [
          credentials.accessToken,
          credentials.refreshToken,
          credentials.idToken,
          credentials.subject,
        ]) {
          assert.notInclude(table, secret);
          assert.notInclude(JSON.stringify(effective.environment), secret);
        }
        const run = Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              extendEnv: false,
              env: {
                ...effective.environment,
                NODE_OPTIONS: `--import ${JSON.stringify(NodeURL.pathToFileURL(preload).href)}`,
              },
            }),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { stdout, stderr, code: Number(code) };
        }).pipe(Effect.scoped);
        assert.deepEqual(yield* run, { stdout: credentials.accessToken, stderr: "", code: 0 });
        yield* save({ ...credentials, expiresAt: 0 });
        const results = yield* Effect.all([run, run], { concurrency: "unbounded" });
        for (const result of results)
          assert.deepEqual(result, { stdout: "fake-renewed-access", stderr: "", code: 0 });
        assert.equal(renewals, 1);
        assert.equal(
          Option.getOrThrow(yield* runtime.auth.read).refreshToken,
          "fake-rotated-refresh",
        );
        assert.deepEqual(
          (yield* fs.readDirectory(config.secretsDir)).filter(
            (name) => name.endsWith(".lock") || name.endsWith(".tmp"),
          ),
          [],
        );
        // Even the same registration and subject must not leak a replacement sign-in's token.
        yield* save({
          ...credentials,
          idToken: "replacement-id-token",
          accessToken: "replacement-access",
        });
        const replaced = yield* run;
        assert.equal(replaced.code, 1);
        assert.equal(replaced.stdout, "");
        assert.notInclude(replaced.stderr, "replacement-access");
        yield* store.remove;
        const loggedOut = yield* run;
        assert.equal(loggedOut.code, 1);
        assert.equal(loggedOut.stdout, "");
        assert.isFalse(yield* fs.exists(path.join(config.baseDir, "wrong-home")));
      }).pipe(
        Effect.provide(
          CodexManagedTokenBroker.layer.pipe(Layer.provideMerge(ServerSecretStore.layer)),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              if (request.url.endsWith("/.well-known/openid-configuration"))
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    issuer: "https://auth.openai.com",
                    authorization_endpoint: "https://auth.openai.com/authorize",
                    token_endpoint: "https://auth.openai.com/token",
                    jwks_uri: "https://auth.openai.com/jwks",
                  }),
                );
              assert.equal(request.url, "https://auth.openai.com/token");
              renewals++;
              assert.equal(renewals, 1, "consumed refresh must never be replayed");
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access_token: "fake-renewed-access",
                  refresh_token: "fake-rotated-refresh",
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: "chatgpt.tokens.use.direct",
                }),
              );
            }),
          ),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Arguments, [
        process.execPath,
        NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
      ]),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
      Effect.provide(
        Layer.mock(CodexInstallation.CodexInstallation)({
          managedDirectory: "/test/managed-codex",
          acquire: () =>
            Effect.succeed({
              executablePath: "/test/codex",
              source: "local",
              version: "0.162.1",
              managedVersionDirectory: null,
            }),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("No parent network expected")),
      ),
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-command-home's space-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
