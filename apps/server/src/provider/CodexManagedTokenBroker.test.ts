// @effect-diagnostics nodeBuiltinImport:off - The helper reaches the broker over its private socket.
import * as NodeNet from "node:net";
import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { vi } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { runManagedChatGptTokenCli } from "../cli/managedChatGptToken.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import { makeCodexManagedRuntime } from "./CodexManagedRuntime.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import type * as Protocol from "./CodexManagedTokenProtocol.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { codexAppServerArgs } from "./codexLaunchArgs.ts";

// Codex, the helper and the broker share one wait. A short one runs the race in real time.
vi.mock("./CodexManagedTokenProtocol.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Protocol>()),
  COMMAND_TIMEOUT_MS: 2_000,
}));

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeSync(CodexSettings);
const decodeCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Array(Schema.String)])),
);

/** Runs the token command in this process, so it waits as long as the broker expects. */
const runHelper = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = process.exitCode;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
          stdout.push(String(chunk));
          return true;
        });
        vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
          stderr.push(String(chunk));
          return true;
        });
      }),
      () =>
        Effect.sync(() => {
          vi.restoreAllMocks();
          process.exitCode = exitCode;
        }),
    );
    yield* Effect.promise(() => runManagedChatGptTokenCli(args));
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode };
  }).pipe(Effect.scoped);

it.live("the helper hears the broker's timeout and a late renewal still saves", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex");
    const initialExitCode = process.exitCode;
    const fs = yield* FileSystem.FileSystem;
    const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "codex-token-timeout-" });
    const data = new Map<string, Uint8Array>();
    const renewalEntered = yield* Deferred.make<void>();
    const renewalRelease = yield* Deferred.make<void>();
    const spentRefreshTokens: string[] = [];
    const executable = {
      executablePath: "/isolated/tools/codex/0.156.1/bin/codex",
      managedVersionDirectory: "/isolated/tools/codex/0.156.1",
      source: "managed" as const,
      version: "0.156.1",
    };
    yield* Effect.gen(function* () {
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
      const credentials = {
        clientId: "oaiapp_test",
        accessToken: "launch-access",
        refreshToken: "single-use-refresh",
        expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
        earliestRefreshAt: null,
        scopes: ["chatgpt.tokens.use.direct"],
        subject: "test-user",
        email: null,
      };
      yield* store.set(new TextEncoder().encode(yield* encodeJson(credentials)));
      const runtime = yield* makeCodexManagedRuntime({
        instanceId,
        enabled: true,
        config: decodeSettings({ setupMode: "managed", homePath: sharedHome }),
        environment: {},
      });
      const broker = yield* CodexManagedTokenBroker.CodexManagedTokenBroker;
      yield* Effect.gen(function* () {
        const effective = yield* runtime.resolve;
        const provider = codexAppServerArgs(effective.config.launchArgs).find((arg) =>
          arg.startsWith("model_providers.openai_token_sharing="),
        )!;
        const [, args] = decodeCommand(
          `[${/auth=\{command=(.*),args=(\[.*\]),timeout_ms=/u
            .exec(provider)!
            .slice(1, 3)
            .join(",")}]`,
        );
        const helperArgs = args.slice(args.indexOf("__managed-chatgpt-token") + 1);

        // The token expires, and its renewal is still on the wire when the wait runs out.
        yield* store.set(
          new TextEncoder().encode(yield* encodeJson({ ...credentials, expiresAt: 0 })),
        );
        const timedOut = yield* runHelper(helperArgs);
        yield* Deferred.await(renewalEntered);
        // The renewal returns once the helper has its answer.
        yield* Deferred.succeed(renewalRelease, undefined);
        yield* broker.awaitIdle;
        assert.deepEqual(
          { helper: timedOut, recorded: (yield* effective.recentTokenRefusal!)?.kind },
          {
            helper: {
              stdout: "",
              stderr: "Timed out waiting for the managed ChatGPT connection. Try again.\n",
              exitCode: 1,
            },
            recorded: "timeout",
          },
        );

        // The renewal that finished after the answer was saved, so the next request needs none.
        assert.deepEqual(yield* runHelper(helperArgs), {
          stdout: "renewed-access",
          stderr: "",
          exitCode: initialExitCode,
        });
        assert.deepEqual(spentRefreshTokens, ["single-use-refresh"]);
      }).pipe(Effect.scoped);
    }).pipe(
      Effect.provide(CodexManagedTokenBroker.layer),
      Effect.provideService(HostProcess.Arguments, [
        process.execPath,
        NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
      ]),
      Effect.provideService(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (key) => Effect.sync(() => Option.fromUndefinedOr(data.get(key))),
          set: (key, value) =>
            Effect.sync(() => {
              data.set(key, value);
            }),
          remove: (key) =>
            Effect.sync(() => {
              data.delete(key);
            }),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
      Effect.provide(
        Layer.mock(CodexInstallation.CodexInstallation)({
          managedDirectory: "/isolated/tools/codex",
          resolve: () => Effect.succeed(executable),
          acquire: () => Effect.succeed(executable),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            if (!request.url.endsWith("/token"))
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  issuer: "https://auth.openai.com",
                  authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
                  token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
                  jwks_uri: "https://auth.openai.com/jwks",
                }),
              );
            if (request.body._tag !== "Uint8Array") return yield* Effect.die("Missing body");
            spentRefreshTokens.push(
              new URLSearchParams(new TextDecoder().decode(request.body.body)).get(
                "refresh_token",
              )!,
            );
            yield* Deferred.succeed(renewalEntered, undefined);
            // A renewal on the wire ignores cancellation: ChatGPT may already have spent the token.
            yield* Deferred.await(renewalRelease).pipe(Effect.uninterruptible);
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: "renewed-access",
                refresh_token: "rotated-refresh",
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
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-token-timeout-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.live(
  "keeps a session's refusal when a helper disconnects before receiving a renewed token",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const initialExitCode = process.exitCode;
      const fs = yield* FileSystem.FileSystem;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "codex-token-disconnect-" });
      const data = new Map<string, Uint8Array>();
      const renewalEntered = yield* Deferred.make<void>();
      const renewalRelease = yield* Deferred.make<void>();
      const spentRefreshTokens: string[] = [];
      let tokenCalls = 0;
      const executable = {
        executablePath: "/isolated/tools/codex/0.156.1/bin/codex",
        managedVersionDirectory: "/isolated/tools/codex/0.156.1",
        source: "managed" as const,
        version: "0.156.1",
      };
      yield* Effect.gen(function* () {
        const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
        const credentials = {
          clientId: "oaiapp_test",
          accessToken: "launch-access",
          refreshToken: "single-use-refresh",
          expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
          earliestRefreshAt: null,
          scopes: ["chatgpt.tokens.use.direct"],
          subject: "test-user",
          email: null,
        };
        yield* store.set(new TextEncoder().encode(yield* encodeJson(credentials)));
        const runtime = yield* makeCodexManagedRuntime({
          instanceId,
          enabled: true,
          config: decodeSettings({ setupMode: "managed", homePath: sharedHome }),
          environment: {},
        });
        const broker = yield* CodexManagedTokenBroker.CodexManagedTokenBroker;
        yield* Effect.gen(function* () {
          const effective = yield* runtime.resolve;
          const provider = codexAppServerArgs(effective.config.launchArgs).find((arg) =>
            arg.startsWith("model_providers.openai_token_sharing="),
          )!;
          const [, args] = decodeCommand(
            `[${/auth=\{command=(.*),args=(\[.*\]),timeout_ms=/u
              .exec(provider)!
              .slice(1, 3)
              .join(",")}]`,
          );
          const helperArgs = args.slice(args.indexOf("__managed-chatgpt-token") + 1);
          const [endpoint, helperInstanceId, environmentId, profileKey, sessionKey] = helperArgs;

          // First request fails renewal and records a refusal for this session.
          yield* store.set(
            new TextEncoder().encode(yield* encodeJson({ ...credentials, expiresAt: 0 })),
          );
          const refused = yield* runHelper(helperArgs);
          assert.equal(refused.exitCode, 1);
          assert.equal((yield* effective.recentTokenRefusal!)?.kind, "refresh");

          // A second helper connects over the real socket and disconnects while renewal is in flight.
          const requestLine =
            (yield* encodeJson({
              version: 1,
              instanceId: helperInstanceId,
              environmentId,
              profileKey,
              sessionKey,
            })) + "\n";
          let receivedBytes = 0;
          const disconnectedSocket = yield* Effect.callback<NodeNet.Socket>((resume) => {
            const socket = NodeNet.createConnection(endpoint!);
            socket.on("error", () => {});
            socket.on("data", (chunk) => {
              receivedBytes += chunk.length;
            });
            socket.once("connect", () => {
              socket.write(requestLine, () => resume(Effect.succeed(socket)));
            });
          });
          yield* Deferred.await(renewalEntered);
          yield* Effect.callback<void>((resume) => {
            if (disconnectedSocket.closed) {
              resume(Effect.void);
              return;
            }
            disconnectedSocket.once("close", () => resume(Effect.void));
            disconnectedSocket.destroy();
          });
          yield* Deferred.succeed(renewalRelease, undefined);
          yield* broker.awaitIdle;

          assert.equal(receivedBytes, 0);
          assert.equal((yield* effective.recentTokenRefusal!)?.kind, "refresh");

          // The renewal was still saved; once a helper actually receives the token, the refusal clears.
          assert.deepEqual(yield* runHelper(helperArgs), {
            stdout: "renewed-access",
            stderr: "",
            exitCode: initialExitCode,
          });
          assert.equal(yield* effective.recentTokenRefusal!, undefined);
          assert.deepEqual(spentRefreshTokens, ["single-use-refresh", "single-use-refresh"]);
        }).pipe(Effect.scoped);
      }).pipe(
        Effect.provide(CodexManagedTokenBroker.layer),
        Effect.provideService(HostProcess.Arguments, [
          process.execPath,
          NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        ]),
        Effect.provideService(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: (key) => Effect.sync(() => Option.fromUndefinedOr(data.get(key))),
            set: (key, value) =>
              Effect.sync(() => {
                data.set(key, value);
              }),
            remove: (key) =>
              Effect.sync(() => {
                data.delete(key);
              }),
            create: () => Effect.die("unused"),
            getOrCreateRandom: () => Effect.die("unused"),
          }),
        ),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(
            EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
          ),
        }),
        Effect.provide(
          Layer.mock(CodexInstallation.CodexInstallation)({
            managedDirectory: "/isolated/tools/codex",
            resolve: () => Effect.succeed(executable),
            acquire: () => Effect.succeed(executable),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              if (!request.url.endsWith("/token"))
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    issuer: "https://auth.openai.com",
                    authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
                    token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
                    jwks_uri: "https://auth.openai.com/jwks",
                  }),
                );
              if (request.body._tag !== "Uint8Array") return yield* Effect.die("Missing body");
              spentRefreshTokens.push(
                new URLSearchParams(new TextDecoder().decode(request.body.body)).get(
                  "refresh_token",
                )!,
              );
              tokenCalls++;
              if (tokenCalls === 1)
                return HttpClientResponse.fromWeb(
                  request,
                  new Response("temporary error", { status: 500 }),
                );
              yield* Deferred.succeed(renewalEntered, undefined);
              yield* Deferred.await(renewalRelease).pipe(Effect.uninterruptible);
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access_token: "renewed-access",
                  refresh_token: "rotated-refresh",
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
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-token-disconnect-" }).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);
