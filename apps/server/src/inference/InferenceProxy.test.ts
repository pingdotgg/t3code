import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  PeerLinkError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  isInferenceProviderConfig,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as InferenceProxy from "./InferenceProxy.ts";
import { traexConsumerRouteKey } from "./traex.ts";
import { proxyVersion } from "./install.ts";

const keychainState = vi.hoisted(() => ({
  password: "",
  hang: false,
  onRead: undefined as (() => void) | undefined,
}));
vi.mock("./claudeKeychain.ts", () => ({
  claudeKeychainEntry: () =>
    new (class {
      async getPassword() {
        if (keychainState.hang) {
          keychainState.onRead?.();
          return await new Promise<string | undefined>(() => {});
        }
        return keychainState.password || undefined;
      }
      async setPassword(password: string) {
        keychainState.password = password;
      }
    })(),
}));

it.effect(
  "restores hosted accounts, scopes grants to consumers and cuts over a working route atomically",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        keychainState.password = "";
        keychainState.hang = false;
        keychainState.onRead = undefined;
        const config = yield* ServerConfig.ServerConfig;
        const state = yield* ServerSecretStore.ServerSecretStore;
        const home = yield* fs.makeTempDirectoryScoped();
        const hostId = EnvironmentId.make("host");
        const peer = { environmentId: EnvironmentId.make("worker"), label: "Workstation" };
        const runtime =
          config.stateDir + "/inference-proxy/runtime/" + proxyVersion + "-darwin-arm64";
        yield* fs.makeDirectory(runtime, { recursive: true });
        yield* fs.writeFileString(runtime + "/cli-proxy-api", "");
        const downloading = yield* Deferred.make<void>();
        const finishDownload = yield* Deferred.make<void>();
        let registryOffline = true;
        let tailnetCatalogDown = false;
        let linked = false;
        let linkedUrl = "http://127.0.0.1:23456";
        let connectionOverride: string | undefined;
        let staleLinkedCatalog = false;
        let remoteCatalogUnavailable = false;
        let fallbackCatalog: typeof catalog | undefined;
        const link = {
          environmentId: hostId,
          label: "Host",
          urls: ["ssh://host"],
          access: "full-access" as const,
          linkedAt: DateTime.makeUnsafe(0),
          expiresAt: DateTime.makeUnsafe(86400000),
          lastReachedAt: null,
          lastError: null,
        };
        let serving = false;
        let poolUnavailable = false;
        let keepRuntimeAvailable = false;
        let runtimeOnlyUnavailable = false;
        let listedAccountRuntimeOnly = false;
        let poolStatusMessage: string | undefined;
        let poolRetryAfter: string | undefined;
        let poolCooldowns: Array<Record<string, unknown>> | undefined;
        let managedClaude = false;
        let managedClaudeStatus = "active";
        let managedClaudeDisabled = false;
        let claudeUsageStatus = 200;
        let claudeUsageCalls = 0;
        let claudeUsage: Record<string, unknown> = {};
        let blockClaudeUsage = false;
        const claudeUsageStarted = yield* Deferred.make<void>();
        const releaseClaudeUsage = yield* Deferred.make<void>();
        let lan = false;
        let rejectNextLaunch = false;
        let currentExit: Deferred.Deferred<void> | undefined;
        let expectRecovery = false;
        const recovered = yield* Deferred.make<void>();
        let configPath = "";
        let starts = 0;
        let stops = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const tailscale =
              ChildProcess.isStandardCommand(command) && command.command === "tailscale";
            if (!tailscale && rejectNextLaunch) {
              rejectNextLaunch = false;
              return yield* PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
              });
            }
            const exited = yield* Deferred.make<void>();
            if (!tailscale) {
              if (ChildProcess.isStandardCommand(command)) configPath = String(command.args[1]);
              currentExit = exited;
              if (expectRecovery) yield* Deferred.succeed(recovered, undefined);
              yield* Effect.addFinalizer(() => Deferred.succeed(exited, undefined));
              starts++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  stops++;
                }),
              );
            }
            const stdout = tailscale
              ? Stream.succeed(
                  new TextEncoder().encode(
                    serving
                      ? '{"Web":{"pool.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:12345"}}}}}'
                      : "{}",
                  ),
                )
              : Stream.empty;
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
              exitCode: tailscale
                ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
                : Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              stdin: Sink.drain,
              stdout,
              stderr: Stream.empty,
              all: stdout,
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        let catalog: readonly { id: string; owned_by?: string }[] = [];
        let identity = hostId;
        let peerId = hostId;
        let connectionDown = false;
        const importedCodexAuth: Record<string, unknown>[] = [];
        const importedClaudeAuth: Record<string, unknown>[] = [];
        const importedCodexFiles: string[] = [];
        const importedClaudeFiles: string[] = [];
        let registryReconciles = 0;
        let activeCodexConfig: unknown;
        let activeCodexEnabled: boolean | undefined;
        const remoteCatalogKeys: (string | undefined)[] = [];
        let peerBridgeKey = "";
        const http = HttpClient.make((request) => {
          if (
            request.url.endsWith("/traex/host/v1/models") ||
            request.url === "http://127.0.0.1:8317/v1/models"
          ) {
            const direct = request.url.startsWith("http://127.0.0.1:8317/");
            const permitted =
              request.headers.authorization ===
              "Bearer " + (direct ? "local-bridge-secret" : peerBridgeKey);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                permitted
                  ? Response.json({ data: [{ id: "traex-test" }] })
                  : new Response(null, { status: 403 }),
              ),
            );
          }
          if (request.url.endsWith("/v0/management/api-call")) {
            const body = request.body;
            if (body._tag !== "Uint8Array" || !body.text) throw new Error("Missing usage request");
            const call = JSON.parse(body.text) as Record<string, unknown>;
            expect(call).toMatchObject({
              auth_index: "claude-auth",
              method: "GET",
              url: "https://api.anthropic.com/api/oauth/usage",
              header: { Authorization: "Bearer $TOKEN$" },
            });
            claudeUsageCalls++;
            return Effect.gen(function* () {
              if (blockClaudeUsage) {
                yield* Deferred.succeed(claudeUsageStarted, undefined);
                yield* Deferred.await(releaseClaudeUsage);
              }
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  status_code: claudeUsageStatus,
                  body: JSON.stringify(claudeUsage),
                }),
              );
            });
          }
          if (new URL(request.url).pathname.endsWith("/v0/management/auth-files/models")) {
            const name = new URL(request.url).searchParams.get("name");
            const models = catalog.filter((model) =>
              name === "claude.json"
                ? model.owned_by === "anthropic"
                : model.owned_by !== "anthropic",
            );
            return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ models })));
          }
          if (request.method === "POST" && request.url.includes("/v0/management/auth-files?")) {
            const body = request.body;
            if (body._tag !== "Uint8Array" || !body.text) throw new Error("Missing auth JSON");
            const credential = JSON.parse(body.text) as Record<string, unknown>;
            const claude = credential.type === "claude";
            const name = new URL(request.url).searchParams.get("name");
            if (name === null) throw new Error("Missing account file name");
            (claude ? importedClaudeAuth : importedCodexAuth).push(credential);
            (claude ? importedClaudeFiles : importedCodexFiles).push(name);
            return fs
              .writeFileString(config.stateDir + `/inference-proxy/accounts/${name}`, body.text)
              .pipe(
                Effect.orDie,
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({ status: "ok" }))),
              );
          }
          if (request.url.endsWith("-auth-url"))
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ state: "sign-in", url: "https://auth.example.com/start" }),
              ),
            );
          if (request.url.includes("/get-auth-status?"))
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ status: "ok" })),
            );
          if (registryOffline && request.url.endsWith("/releases/latest"))
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
            );
          if (request.url.endsWith("/releases/latest"))
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  tag_name: "v8.0.61",
                  draft: false,
                  prerelease: false,
                  assets: [
                    {
                      id: 123,
                      name: "CLIProxyAPI_8.0.61_darwin_aarch64.tar.gz",
                      size: 1,
                      digest: "sha256:" + "0".repeat(64),
                    },
                  ],
                }),
              ),
            );
          if (request.url.endsWith("/assets/123"))
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(new Uint8Array(1))),
            ).pipe(
              Effect.tap(() => Deferred.succeed(downloading, undefined)),
              Effect.tap(() => Deferred.await(finishDownload)),
            );
          if (
            request.url.includes("/api/inference") ||
            request.url.includes("/.well-known/t3/environment")
          ) {
            if (request.url.endsWith("/.well-known/t3/environment")) {
              expect(request.headers.authorization).toBeUndefined();
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    environmentId: request.url.startsWith("https://fallback.example.ts.net/")
                      ? EnvironmentId.make("other-host")
                      : peerId,
                  }),
                ),
              );
            }
            if (!request.url.endsWith("/health"))
              remoteCatalogKeys.push(request.headers.authorization);
            if (request.url.endsWith("/v1/models") && remoteCatalogUnavailable)
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 502 })),
              );
            if (
              request.url.startsWith("https://fallback.example.ts.net/api/inference/") &&
              fallbackCatalog
            )
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    request.url.endsWith("/health")
                      ? { availableDrivers: ["codex"], models: fallbackCatalog.map(({ id }) => id) }
                      : { data: fallbackCatalog },
                  ),
                ),
              );
            if (staleLinkedCatalog && request.url.startsWith("http://127.0.0.1:34567/"))
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 502 })),
              );
            if (tailnetCatalogDown && request.url.startsWith("https:"))
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 502 })),
              );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.endsWith("/health")
                  ? new URL(request.url).pathname === "/health"
                    ? { status: "ok" }
                    : {
                        availableDrivers: poolUnavailable ? [] : ["codex", "opencode", "pi"],
                        models: catalog.map((model) => model.id),
                      }
                  : request.url.endsWith("auth-files")
                    ? {
                        files: [
                          ...(managedClaude
                            ? [
                                {
                                  id: "claude.json",
                                  name: "claude.json",
                                  auth_index: "claude-auth",
                                  provider: "claude",
                                  status: managedClaudeStatus,
                                  disabled: managedClaudeDisabled,
                                },
                              ]
                            : []),
                          {
                            name: "codex:api-key:fixture",
                            provider: "codex",
                            status: "active",
                            unavailable:
                              runtimeOnlyUnavailable || (poolUnavailable && !keepRuntimeAvailable),
                            runtime_only: true,
                          },
                          {
                            name: "one.json",
                            provider: "codex",
                            status: "active",
                            unavailable: poolUnavailable,
                            runtime_only: listedAccountRuntimeOnly,
                            status_message: poolStatusMessage,
                            next_retry_after: poolRetryAfter,
                            cooldowns: poolCooldowns,
                            refresh_token: "must stay local",
                          },
                        ],
                      }
                    : { data: catalog },
              ),
            ),
          );
        });
        const service = InferenceProxy.layer.pipe(
          Layer.provide(
            Layer.mock(PeerLinks.PeerLinks)({
              get: () => Effect.succeed(linked ? Option.some(link) : Option.none()),
              resolveAddress: () =>
                connectionDown
                  ? Effect.fail(
                      new PeerLinkError({
                        reason: "unreachable",
                        message: "SSH connection unavailable",
                      }),
                    )
                  : Effect.succeed(connectionOverride ?? linkedUrl),
              resolve: () =>
                linked
                  ? Effect.succeed({ link, url: linkedUrl, token: "must-not-forward-peer-token" })
                  : Effect.fail(new PeerLinkError({ reason: "unknown_link", message: "unlinked" })),
            }),
          ),
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          Layer.provide(
            Layer.mock(DirectEndpoints)({
              resolveAvailable: () =>
                Effect.succeed(
                  lan ? [{ kind: "lan", httpBaseUrl: "http://192.168.1.12:12345/" }] : [],
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.sync(() => identity),
            }),
          ),
          Layer.provide(Layer.succeed(ServerConfig.ServerConfig, { ...config, port: 12345 })),
          Layer.provide(
            Layer.succeed(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator, {
              reconcile: (instances) =>
                Effect.sync(() => {
                  registryReconciles++;
                  const activeCodex = instances[ProviderInstanceId.make("codex")];
                  activeCodexConfig = activeCodex?.config;
                  activeCodexEnabled = activeCodex?.enabled;
                }),
              reloadSecrets: () => Effect.void,
              rebuild: () => Effect.void,
              applySecret: () => Effect.succeed([]),
            }),
          ),
          Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
          Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
          Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
          Layer.provide(Layer.succeed(HostProcess.Architecture, "arm64")),
          Layer.provide(Layer.succeed(HostProcess.Username, "test-user")),
          Layer.provide(
            Layer.succeed(HostProcess.Environment, { OPENCODE_CONFIG_CONTENT: '{"provider":' }),
          ),
          Layer.provide(NetService.layer),
          Layer.fresh,
        );
        const settings = yield* ServerSettings.ServerSettingsService;
        const legacyRoutes = [
          {
            driver: "codex" as const,
            hostId,
            baseUrl: "http://127.0.0.1:23456",
            key: "legacy-local-key",
          },
          {
            driver: "claudeAgent" as const,
            hostId: EnvironmentId.make("offline-host"),
            baseUrl: "http://192.168.1.44:12345/api/inference",
            key: "legacy-lan-key",
          },
        ];
        for (const route of legacyRoutes)
          yield* settings.updateProviderInstance({
            operation: "upsert",
            instanceId: ProviderInstanceId.make(route.driver),
            instance: {
              driver: ProviderDriverKind.make(route.driver),
              enabled: false,
              config: {
                inferenceEnabled: true,
                inferenceHostId: route.hostId,
                inferenceHostLabel: "",
                inferenceBaseUrl: route.baseUrl,
                inferenceKey: route.key,
                inferenceModels: [route.driver === "codex" ? "gpt-legacy" : "claude-legacy"],
                inferenceHomePath: home,
              },
            },
          });
        const cliHome = home + "/.codex";
        const claudeHome = home + "/.claude";
        const claudeAuthFile = claudeHome + "/.credentials.json";
        const accountFile = config.stateDir + "/inference-proxy/accounts/one.json";
        const unknownAccountFile = config.stateDir + "/inference-proxy/accounts/unknown.json";
        const idToken = (email: string) =>
          "header." + Buffer.from(JSON.stringify({ email })).toString("base64url") + ".sig";
        const unknownAccount = JSON.stringify({
          type: "codex",
          account_id: "same-account",
          access_token: "unknown-access",
          refresh_token: "unknown-refresh",
          id_token: "unknown-id",
          last_refresh: "2026-11-30T00:00:00Z",
        });
        const accessToken =
          "header." +
          Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url") +
          ".sig";
        yield* fs.makeDirectory(cliHome, { recursive: true });
        yield* fs.makeDirectory(claudeHome, { recursive: true });
        yield* fs.makeDirectory(config.stateDir + "/inference-proxy/accounts", {
          recursive: true,
        });
        yield* fs.writeFileString(unknownAccountFile, unknownAccount);
        yield* fs.writeFileString(
          accountFile,
          JSON.stringify({
            type: "codex",
            account_id: "same-account",
            email: "person@example.com",
            access_token: "old-access",
            refresh_token: "old-refresh",
            id_token: idToken("person@example.com"),
            last_refresh: "2026-11-09T00:00:00Z",
            note: "keep this metadata",
          }),
        );
        yield* fs.writeFileString(
          cliHome + "/auth.json",
          JSON.stringify({
            auth_mode: "chatgpt",
            last_refresh: "2026-11-10T00:00:00Z",
            tokens: {
              account_id: "same-account",
              access_token: accessToken,
              refresh_token: "new-refresh",
              id_token: idToken("person@example.com"),
            },
          }),
        );
        yield* fs.writeFileString(
          home + "/.claude.json",
          JSON.stringify({
            oauthAccount: {
              accountUuid: "claude-account",
              organizationUuid: "org",
              emailAddress: "person@example.com",
              organizationName: "Team",
            },
          }),
        );
        yield* fs.writeFileString(
          claudeAuthFile,
          JSON.stringify({
            customSetting: "keep",
            claudeAiOauth: {
              accessToken: "native-access",
              refreshToken: "native-refresh",
              expiresAt: 4102444800000,
              scopes: ["user:inference"],
            },
          }),
        );
        const { grant, oldPort } = yield* Effect.scoped(
          Effect.gen(function* () {
            const proxy = yield* InferenceProxy.InferenceProxy;
            expect((yield* proxy.status).enabled).toBe(false);
            yield* proxy.bindRoutes(45678);
            expect(remoteCatalogKeys).toEqual([]);
            for (const route of legacyRoutes) {
              const current = (yield* settings.getSettings).providerInstances[
                ProviderInstanceId.make(route.driver)
              ];
              expect(current?.config).toMatchObject({
                inferenceBaseUrl: `http://127.0.0.1:45678/api/inference/linked/${route.driver}/${route.hostId}`,
                inferenceKey: route.key,
              });
            }
            const migrated = yield* state.get("inference-proxy-state");
            expect(Option.isSome(migrated)).toBe(true);
            if (Option.isSome(migrated)) {
              const saved = JSON.parse(new TextDecoder().decode(migrated.value)) as {
                routePools: { driver: string; primary: { baseUrl: string; key: string } }[];
              };
              for (const route of legacyRoutes)
                expect(
                  saved.routePools.find((pool) => pool.driver === route.driver)?.primary,
                ).toMatchObject({
                  baseUrl: route.baseUrl,
                  key: route.key,
                });
            }
            for (const route of legacyRoutes)
              yield* proxy.manage({
                operation: "removeRoute",
                instanceId: ProviderInstanceId.make(route.driver),
              });
            const incomplete = ProviderInstanceId.make("claudeAgent");
            yield* settings.updateProviderInstance({
              operation: "upsert",
              instanceId: incomplete,
              instance: {
                driver: ProviderDriverKind.make("claudeAgent"),
                enabled: false,
                config: { inferenceEnabled: true },
              },
            });
            yield* proxy.manage({ operation: "removeRoute", instanceId: incomplete });
            expect((yield* settings.getSettings).providerInstances[incomplete]).toMatchObject({
              enabled: false,
              config: { inferenceEnabled: false },
            });
            const startSharing = proxy.manage({
              operation: "configure",
              enabled: true,
              sharing: true,
            });
            yield* startSharing;
            expect((yield* proxy.status).enabled).toBe(true);
            expect(importedCodexAuth).toMatchObject([
              {
                type: "codex",
                account_id: "same-account",
                refresh_token: "new-refresh",
                note: "keep this metadata",
              },
            ]);
            expect(yield* fs.readFileString(unknownAccountFile)).toBe(unknownAccount);
            yield* proxy.manage({ operation: "removeAccount", name: "unknown.json" });
            yield* fs.remove(unknownAccountFile);
            expect(importedClaudeAuth).toMatchObject([
              {
                type: "claude",
                account_uuid: "claude-account",
                organization_uuid: "org",
                refresh_token: "native-refresh",
              },
            ]);
            const claudeProxyFile =
              config.stateDir + `/inference-proxy/accounts/${importedClaudeFiles[0]}`;
            yield* fs.writeFileString(
              claudeProxyFile,
              JSON.stringify({
                type: "claude",
                account_uuid: "claude-account",
                organization_uuid: "org",
                email: "person@example.com",
                access_token: "proxy-access",
                refresh_token: "proxy-refresh",
                expired: "2101-01-01T00:00:00.000Z",
              }),
            );
            yield* proxy.status;
            expect(JSON.parse(yield* fs.readFileString(claudeAuthFile))).toMatchObject({
              customSetting: "keep",
              claudeAiOauth: {
                accessToken: "proxy-access",
                refreshToken: "proxy-refresh",
                scopes: ["user:inference"],
              },
            });
            yield* fs.writeFileString(
              claudeAuthFile,
              JSON.stringify({
                customSetting: "keep",
                claudeAiOauth: {
                  accessToken: "new-native-access",
                  refreshToken: "new-native-refresh",
                  expiresAt: 4167849600000,
                  scopes: ["user:inference"],
                },
              }),
            );
            yield* proxy.status;
            expect(importedClaudeAuth.at(-1)).toMatchObject({
              access_token: "new-native-access",
              refresh_token: "new-native-refresh",
            });
            keychainState.password = JSON.stringify({
              customSetting: "keychain",
              claudeAiOauth: {
                accessToken: "keychain-access",
                refreshToken: "keychain-refresh",
                expiresAt: 4199385600000,
              },
            });
            yield* proxy.status;
            expect(importedClaudeAuth.at(-1)).toMatchObject({
              access_token: "keychain-access",
              refresh_token: "keychain-refresh",
            });
            yield* fs.remove(claudeAuthFile);
            yield* fs.writeFileString(
              claudeProxyFile,
              JSON.stringify({
                type: "claude",
                account_uuid: "claude-account",
                organization_uuid: "org",
                email: "person@example.com",
                access_token: "new-proxy-access",
                refresh_token: "new-proxy-refresh",
                expired: "2104-01-01T00:00:00.000Z",
              }),
            );
            yield* proxy.status;
            expect(JSON.parse(keychainState.password)).toMatchObject({
              customSetting: "keychain",
              claudeAiOauth: {
                accessToken: "new-proxy-access",
                refreshToken: "new-proxy-refresh",
              },
            });
            keychainState.hang = true;
            const readStarted = new Promise<void>((resolve) => {
              keychainState.onRead = resolve;
            });
            const stalledStatus = yield* proxy.status.pipe(Effect.forkChild);
            yield* Effect.promise(() => readStarted);
            yield* TestClock.adjust("6 seconds");
            expect(stalledStatus.pollUnsafe()).toBeDefined();
            expect((yield* Fiber.join(stalledStatus)).problem).toContain("Keychain");
            keychainState.hang = false;
            keychainState.onRead = undefined;
            expect(yield* fs.readFileString(cliHome + "/auth.json")).toContain("new-refresh");
            yield* proxy.status;
            expect(importedCodexAuth).toHaveLength(1);
            yield* fs.writeFileString(
              cliHome + "/auth.json",
              JSON.stringify({
                auth_mode: "chatgpt",
                last_refresh: "2026-11-11T00:00:00Z",
                tokens: {
                  account_id: "same-account",
                  access_token: accessToken,
                  refresh_token: "next-refresh",
                  id_token: idToken("person@example.com"),
                },
              }),
            );
            yield* proxy.status;
            expect(importedCodexAuth).toHaveLength(2);
            expect(importedCodexAuth[1]).toMatchObject({
              refresh_token: "next-refresh",
              note: "keep this metadata",
            });
            yield* fs.writeFileString(
              cliHome + "/auth.json",
              JSON.stringify({
                auth_mode: "chatgpt",
                customSetting: "keep",
                last_refresh: "2026-11-09T00:00:00Z",
                tokens: {
                  account_id: "same-account",
                  access_token: accessToken,
                  refresh_token: "stale-refresh",
                  id_token: idToken("person@example.com"),
                },
              }),
            );
            yield* proxy.status;
            expect(importedCodexAuth).toHaveLength(2);
            yield* fs.writeFileString(
              accountFile,
              JSON.stringify({
                type: "codex",
                account_id: "same-account",
                email: "person@example.com",
                access_token: accessToken,
                refresh_token: "proxy-refresh",
                id_token: idToken("person@example.com"),
                last_refresh: "2026-11-12T00:00:00Z",
                note: "keep this metadata",
              }),
            );
            yield* proxy.status;
            expect(yield* fs.readFileString(cliHome + "/auth.json")).toContain("proxy-refresh");
            expect(yield* fs.readFileString(cliHome + "/auth.json")).toContain("customSetting");
            // A removed account stays out of the pool until the user signs in again.
            const pooledAccount = yield* fs.readFileString(accountFile);
            const signedInLocally = (
              refreshToken: string,
              lastRefresh: string,
              email = "person@example.com",
            ) =>
              fs.writeFileString(
                cliHome + "/auth.json",
                JSON.stringify({
                  auth_mode: "chatgpt",
                  last_refresh: lastRefresh,
                  tokens: {
                    account_id: "same-account",
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    id_token: idToken(email),
                  },
                }),
              );
            yield* proxy.manage({ operation: "removeAccount", name: "one.json" });
            yield* fs.remove(accountFile);
            yield* signedInLocally("after-removal", "2026-11-13T00:00:00Z");
            yield* proxy.status;
            expect(importedCodexAuth).toHaveLength(2);
            yield* signedInLocally("other-seat", "2026-11-13T00:00:00Z", "other@example.com");
            yield* proxy.status;
            expect(importedCodexAuth).toHaveLength(3);
            const otherAccountFile =
              config.stateDir + `/inference-proxy/accounts/${importedCodexFiles[2]}`;
            const withoutEmail = { ...importedCodexAuth[2] };
            delete withoutEmail.email;
            yield* fs.writeFileString(otherAccountFile, JSON.stringify(withoutEmail));
            yield* signedInLocally("after-removal", "2026-11-13T00:00:00Z", "PERSON@example.com");
            yield* proxy.status;
            expect(importedCodexAuth).toHaveLength(3);
            yield* proxy.manage({ operation: "signIn", upstream: "codex" });
            yield* proxy.status;
            expect(importedCodexAuth).toHaveLength(4);
            expect(importedCodexFiles[3]).not.toBe(importedCodexFiles[2]);
            expect(JSON.parse(yield* fs.readFileString(otherAccountFile))).toMatchObject({
              id_token: withoutEmail.id_token,
              refresh_token: "other-seat",
            });
            yield* proxy.manage({ operation: "removeAccount", name: importedCodexFiles[3]! });
            yield* fs.remove(
              config.stateDir + `/inference-proxy/accounts/${importedCodexFiles[3]}`,
            );
            yield* signedInLocally(
              "other-refreshed",
              "2026-11-14T00:00:00Z",
              " OTHER@example.com ",
            );
            yield* proxy.status;
            expect(importedCodexFiles.at(-1)).toBe(importedCodexFiles[2]);
            expect(JSON.parse(yield* fs.readFileString(otherAccountFile))).toMatchObject({
              refresh_token: "other-refreshed",
            });
            yield* proxy.manage({ operation: "signIn", upstream: "codex" });
            yield* proxy.manage({ operation: "removeAccount", name: importedCodexFiles[2]! });
            yield* fs.remove(otherAccountFile);
            yield* fs.writeFileString(accountFile, pooledAccount);
            yield* signedInLocally("person-returned", "2026-11-15T00:00:00Z");
            yield* proxy.status;
            expect(JSON.parse(yield* fs.readFileString(accountFile))).toMatchObject({
              refresh_token: "person-returned",
            });
            const knownAccount = yield* fs.readFileString(accountFile);
            yield* signedInLocally("unknown-local", "2026-11-16T00:00:00Z", "");
            expect((yield* proxy.status).problem).toContain(
              "Local Codex sign-in has no account email",
            );
            expect(yield* fs.readFileString(accountFile)).toBe(knownAccount);
            expect(yield* fs.readFileString(cliHome + "/auth.json")).toContain("unknown-local");
            yield* proxy.manage({ operation: "signIn", upstream: "codex" });
            yield* fs.writeFileString(accountFile, pooledAccount);
            yield* signedInLocally("proxy-refresh", "2026-11-12T00:00:00Z");
            expect((yield* proxy.grant(peer)).baseUrl).toBe("t3-environment:host");
            lan = true;
            yield* startSharing;
            expect((yield* proxy.grant(peer)).baseUrl).toBe(
              "http://192.168.1.12:12345/api/inference",
            );
            serving = true;
            yield* startSharing;
            const { accounts } = yield* proxy.status;
            expect(accounts).toEqual([
              { name: "one.json", provider: "codex", status: "active", availability: "available" },
            ]);
            listedAccountRuntimeOnly = true;
            expect((yield* proxy.status).accounts).toEqual([]);
            expect((yield* proxy.status).availableDrivers).toContain("codex");
            listedAccountRuntimeOnly = false;
            poolUnavailable = true;
            poolStatusMessage = "HTTP 429 quota exhausted";
            poolRetryAfter = "2026-11-17T20:00:00Z";
            expect((yield* proxy.status).accounts[0]).toMatchObject({
              availability: "rateLimited",
              retryAfter: poolRetryAfter,
            });
            poolStatusMessage = "Failed to authenticate. API Error: 403 status code (no body)";
            poolRetryAfter = undefined;
            expect((yield* proxy.status).accounts[0]).toMatchObject({
              availability: "authenticationError",
            });
            poolStatusMessage = "service_overloaded (HTTP 529)";
            expect((yield* proxy.status).accounts[0]).toMatchObject({
              availability: "unavailable",
            });
            expect((yield* proxy.status).accounts[0]).not.toHaveProperty("retryAfter");
            poolStatusMessage = undefined;
            poolRetryAfter = "1960-01-01T00:00:00Z";
            expect((yield* proxy.status).accounts[0]).toMatchObject({
              availability: "unavailable",
            });
            expect((yield* proxy.status).accounts[0]).not.toHaveProperty("retryAfter");
            poolUnavailable = false;
            poolStatusMessage = undefined;
            poolRetryAfter = undefined;
            catalog = [
              { id: "gpt-quota-fixture", owned_by: "openai" },
              { id: "claude-quota-fixture", owned_by: "anthropic" },
            ];
            const claudeResetAt = DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 30 * 60_000),
            );
            managedClaude = true;
            claudeUsage = {
              five_hour: { utilization: 100, resets_at: claudeResetAt },
              seven_day: { utilization: 84, resets_at: claudeResetAt },
              extra_usage: {
                is_enabled: false,
                monthly_limit: null,
                used_credits: null,
                utilization: null,
              },
            };
            expect(
              (yield* proxy.status).accounts.find((account) => account.name === "claude.json"),
            ).toMatchObject({ availability: "rateLimited", retryAfter: claudeResetAt });
            expect((yield* proxy.status).availableDrivers).not.toContain("claudeAgent");
            const hosted = yield* proxy.grant(peer);
            expect((yield* proxy.health(hosted.key))?.availableDrivers).not.toContain(
              "claudeAgent",
            );
            expect((yield* proxy.health(hosted.key))?.models).toEqual(["gpt-quota-fixture"]);
            expect(claudeUsageCalls).toBe(1);
            yield* TestClock.adjust("31 seconds");
            claudeUsage = {
              five_hour: { utilization: 50, resets_at: claudeResetAt },
              seven_day: { utilization: 100, resets_at: claudeResetAt },
              limits: [
                {
                  kind: "weekly_scoped",
                  percent: 100,
                  resets_at: claudeResetAt,
                  scope: { model: { display_name: "Fable" } },
                },
              ],
            };
            expect(
              (yield* proxy.status).accounts.find((account) => account.name === "claude.json"),
            ).toMatchObject({ availability: "rateLimited", retryAfter: claudeResetAt });
            expect(claudeUsageCalls).toBe(2);
            yield* TestClock.adjust("31 seconds");
            claudeUsage = {
              five_hour: { utilization: 50, resets_at: claudeResetAt },
              seven_day: { utilization: 70, resets_at: claudeResetAt },
              limits: [
                {
                  kind: "weekly_scoped",
                  percent: 100,
                  resets_at: claudeResetAt,
                  scope: { model: { display_name: "Fable" } },
                },
              ],
              extra_usage: {
                is_enabled: true,
                monthly_limit: 10,
                used_credits: 10,
                utilization: 100,
              },
            };
            expect(
              (yield* proxy.status).accounts.find((account) => account.name === "claude.json"),
            ).toMatchObject({ availability: "available" });
            expect((yield* proxy.health(hosted.key))?.availableDrivers).toContain("claudeAgent");
            expect((yield* proxy.health(hosted.key))?.models).toEqual([
              "gpt-quota-fixture",
              "claude-quota-fixture",
            ]);
            poolCooldowns = [
              {
                scope: "model",
                model_key: "gpt-quota-fixture",
                reason: "quota",
                retry_at: claudeResetAt,
                remaining_seconds: 1_800,
              },
            ];
            runtimeOnlyUnavailable = true;
            expect((yield* proxy.health(hosted.key))?.models).toEqual(["claude-quota-fixture"]);
            poolCooldowns = undefined;
            runtimeOnlyUnavailable = false;
            yield* TestClock.adjust("31 seconds");
            claudeUsage = {
              five_hour: { utilization: 100, resets_at: claudeResetAt },
              seven_day: { utilization: 100, resets_at: claudeResetAt },
              extra_usage: {
                is_enabled: true,
                monthly_limit: 10,
                used_credits: 1,
                utilization: 10,
              },
            };
            expect(
              (yield* proxy.status).accounts.find((account) => account.name === "claude.json"),
            ).toMatchObject({ availability: "available" });
            yield* TestClock.adjust("31 seconds");
            claudeUsageStatus = 403;
            expect(
              (yield* proxy.status).accounts.find((account) => account.name === "claude.json"),
            ).toMatchObject({ availability: "available" });
            yield* TestClock.adjust("31 seconds");
            managedClaudeStatus = "error";
            expect(
              (yield* proxy.status).accounts.find((account) => account.name === "claude.json"),
            ).toMatchObject({ availability: "unavailable" });
            expect(claudeUsageCalls).toBe(5);
            managedClaudeStatus = "active";
            managedClaudeDisabled = true;
            expect(
              (yield* proxy.status).accounts.find((account) => account.name === "claude.json"),
            ).toMatchObject({ availability: "disabled" });
            expect(claudeUsageCalls).toBe(5);
            managedClaudeDisabled = false;
            claudeUsageStatus = 200;
            blockClaudeUsage = true;
            expect((yield* proxy.health(hosted.key))?.availableDrivers).toContain("claudeAgent");
            yield* Deferred.await(claudeUsageStarted);
            yield* Deferred.succeed(releaseClaudeUsage, undefined);
            blockClaudeUsage = false;
            managedClaude = false;
            catalog = [];
            yield* proxy.manage({ operation: "setRouting", strategy: "fill-first" });
            yield* proxy.manage({ operation: "setRouting", sessionAffinity: false });
            const readConfig = fs
              .readFileString(configPath)
              .pipe(Effect.map((s) => JSON.parse(s) as Record<string, unknown>));
            expect(yield* readConfig).toMatchObject({
              routing: { strategy: "fill-first", "session-affinity": false },
            });
            expect((yield* readConfig)["oauth"]).not.toHaveProperty("model-alias");
            const issued = yield* proxy.grant(peer);
            yield* fs.makeDirectory(home + "/.traex-bridge", { recursive: true });
            yield* fs.writeFileString(home + "/.traex-bridge/api-key", "local-bridge-secret");
            const beforeDiscovery = registryReconciles;
            yield* proxy.refreshModelCatalog(true, ProviderInstanceId.make("codex_traex"));
            expect(registryReconciles).toBe(beforeDiscovery + 1);
            yield* proxy.refreshModelCatalog(true, ProviderInstanceId.make("codex_traex"));
            expect(registryReconciles).toBe(beforeDiscovery + 1);
            expect((yield* proxy.status).traexAvailable).toBe(true);
            const bridgeGrant = yield* proxy.grant({
              ...peer,
              capability: "traex",
              automatic: true,
            });
            peerBridgeKey = bridgeGrant.key;
            expect(bridgeGrant.key).not.toBe(issued.key);
            expect(yield* proxy.authorize(bridgeGrant.key)).toBeNull();
            expect(yield* proxy.traexCandidates("host", issued.key)).toBeNull();
            expect(yield* proxy.traexCandidates("host", bridgeGrant.key)).toEqual([
              { baseUrl: "http://127.0.0.1:8317", key: "local-bridge-secret", models: [] },
            ]);
            const consumerBridgeKey = yield* traexConsumerRouteKey(state);
            expect(
              yield* proxy.traexCandidates("resolve", consumerBridgeKey, "generic-codex-only"),
            ).toEqual([]);
            expect(
              yield* proxy.traexCandidates("resolve", consumerBridgeKey, "traex-test"),
            ).toMatchObject([{ baseUrl: "http://127.0.0.1:8317", models: ["traex-test"] }]);
            yield* fs.remove(home + "/.traex-bridge/api-key");
            yield* proxy.refreshModelCatalog(true, ProviderInstanceId.make("codex_traex"));
            expect(registryReconciles).toBe(beforeDiscovery + 2);
            yield* proxy.manage({
              operation: "configure",
              enabled: true,
              sharing: false,
              expectedEnabled: false,
            });
            expect((yield* proxy.status).sharing).toBe(true);
            expect(issued.baseUrl).toBe("https://pool.example.ts.net/api/inference");
            expect((yield* proxy.grant(peer)).key).toBe(issued.key);
            expect((yield* proxy.authorize(issued.key))?.key).not.toBe(issued.key);
            const local = yield* proxy.grant({ environmentId: hostId, label: "Host" });
            expect(yield* proxy.health("wrong-key")).toBeNull();
            expect((yield* proxy.health(issued.key))?.availableDrivers).toEqual([
              "codex",
              "opencode",
              "pi",
            ]);
            poolUnavailable = true;
            expect((yield* proxy.health(issued.key))?.availableDrivers).toEqual([]);
            keepRuntimeAvailable = true;
            expect((yield* proxy.health(issued.key))?.availableDrivers).toContain("codex");
            keepRuntimeAvailable = false;
            poolUnavailable = false;
            expect((yield* proxy.health(issued.key))?.availableDrivers).toContain("codex");
            const connect = { grant: local, driver: "codex" as const, hostLabel: "Host" };
            expect(yield* proxy.connect(connect).pipe(Effect.flip)).toHaveProperty(
              "_tag",
              "InferenceProxyError",
            );
            catalog = [
              { id: "codex-auto-review", owned_by: "openai" },
              { id: "office-model", owned_by: "openai" },
              { id: "gpt-other", owned_by: "anthropic" },
              { id: "gpt-fixture" },
              { id: "codex-pool-work", owned_by: "openai" },
              { id: "claude-pool-sonnet", owned_by: "anthropic" },
            ];
            poolUnavailable = true;
            expect((yield* proxy.connect(connect).pipe(Effect.flip)).message).toContain(
              "no available accounts",
            );
            poolUnavailable = false;
            expect(
              (yield* proxy
                .connect({ ...connect, grant: { ...local, key: "expired-local-key" } })
                .pipe(Effect.flip)).message,
            ).toContain("local inference");
            const openCodeId = ProviderInstanceId.make("opencode");
            const openCodeNative = {
              driver: ProviderDriverKind.make("opencode"),
              environment: [
                { name: "OPENCODE_CONFIG_CONTENT", value: '{"provider":', sensitive: false },
              ],
            };
            const openCodeConnect = { ...connect, driver: "opencode" as const };
            for (const instance of [{ driver: openCodeNative.driver }, openCodeNative]) {
              yield* settings.updateProviderInstance({
                operation: "upsert",
                instanceId: openCodeId,
                instance,
              });
              expect(yield* proxy.connect(openCodeConnect).pipe(Effect.result)).toMatchObject({
                _tag: "Failure",
                failure: {
                  _tag: "InferenceProxyError",
                  message: expect.stringContaining("OPENCODE_CONFIG_CONTENT"),
                },
              });
              expect((yield* settings.getSettings).providerInstances[openCodeId]).toEqual(instance);
            }
            yield* settings.updateProviderInstance({
              operation: "upsert",
              instanceId: openCodeId,
              instance: {
                ...openCodeNative,
                environment: [
                  {
                    name: "OPENCODE_CONFIG_CONTENT",
                    value: '{ /* native */ "provider": { "own": {}, }, }',
                    sensitive: false,
                  },
                ],
              },
            });
            yield* proxy.connect(openCodeConnect);
            expect((yield* proxy.status).routes).toContainEqual({
              instanceId: openCodeId,
              label: "OpenCode",
            });
            yield* settings.updateProviderInstance({
              operation: "upsert",
              instanceId: openCodeId,
              instance: {
                ...(yield* settings.getSettings).providerInstances[openCodeId]!,
                environment: openCodeNative.environment,
              },
            });
            const invalidRouteStatus = yield* proxy.status;
            expect(invalidRouteStatus.routes).toEqual([]);
            expect(invalidRouteStatus.problem).toContain("OPENCODE_CONFIG_CONTENT");
            yield* proxy.manage({ operation: "removeRoute", instanceId: openCodeId });
            const native = {
              driver: ProviderDriverKind.make("codex"),
              displayName: "Codex",
              config: {
                setupMode: "existing",
                homePath: "/native/home",
                launchArgs: "--native-argument",
                customModels: ["gpt-native"],
              },
              environment: [
                { name: "OPENAI_API_KEY", value: "native-credential", sensitive: true },
              ],
            };
            yield* settings.updateProviderInstance({
              operation: "upsert",
              instanceId: ProviderInstanceId.make("codex"),
              instance: native,
            });
            yield* proxy.connect(connect);
            let configured = (yield* settings.getSettings).providerInstances[
              ProviderInstanceId.make("codex")
            ];
            expect(configured).toMatchObject({
              ...native,
              config: {
                ...native.config,
                inferenceModels: [
                  "codex-auto-review",
                  "office-model",
                  "gpt-fixture",
                  "codex-pool-work",
                ],
                inferenceHostLabel: "",
                inferenceEnabled: true,
                inferenceBaseUrl: "http://127.0.0.1:12345/api/inference/linked/codex/host",
              },
            });
            expect((yield* proxy.status).routes).toEqual([{ instanceId: "codex", label: "Codex" }]);
            expect(activeCodexConfig).toMatchObject({
              setupMode: "inference",
              homePath: expect.stringContaining("/providers/inference/codex"),
              inferenceBaseUrl: "http://127.0.0.1:12345/api/inference/linked/codex/host",
            });
            if (!isInferenceProviderConfig(configured?.config))
              throw new Error("Expected a local inference route");
            expect(yield* proxy.health(local.key, hostId, "codex")).toMatchObject({
              availableDrivers: ["codex"],
              models: expect.arrayContaining(["codex-auto-review"]),
            });
            expect(yield* proxy.routeHealth(configured.config, local.key, "codex")).toMatchObject({
              availableDrivers: expect.arrayContaining(["codex"]),
            });
            const initialCatalog = catalog;
            catalog = [...catalog, { id: "gpt-local-new", owned_by: "openai" }];
            yield* proxy.refreshModelCatalog();
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({ inferenceModels: expect.arrayContaining(["gpt-local-new"]) });
            expect(activeCodexConfig).toMatchObject({
              customModels: expect.arrayContaining(["gpt-local-new"]),
            });
            const astra = "gpt-local-new";
            catalog = initialCatalog;
            poolCooldowns = [
              {
                scope: "model",
                model_key: astra,
                retry_at: DateTime.formatIso(
                  DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 320_000),
                ),
              },
            ];
            yield* proxy.refreshModelCatalog(true, ProviderInstanceId.make("codex"));
            expect(activeCodexConfig).toMatchObject({
              customModels: expect.arrayContaining([astra]),
            });
            expect(yield* proxy.routeHealth(configured.config, local.key, "codex")).toMatchObject({
              unavailableModels: [astra],
            });
            expect(yield* proxy.routeCandidates(local.key, hostId, "codex", astra)).toEqual([]);
            poolCooldowns = undefined;
            catalog = [...initialCatalog, { id: astra, owned_by: "openai" }];
            yield* proxy.refreshModelCatalog(true, ProviderInstanceId.make("codex"));
            expect(yield* proxy.routeCandidates(local.key, hostId, "codex", astra)).toHaveLength(1);
            catalog = initialCatalog;
            yield* proxy.refreshModelCatalog(true, ProviderInstanceId.make("codex"));
            expect(activeCodexConfig).toMatchObject({
              customModels: expect.not.arrayContaining([astra]),
            });
            const piId = ProviderInstanceId.make("pi");
            yield* proxy.connect({
              ...connect,
              driver: "pi",
              grant: {
                ...issued,
                hostId: EnvironmentId.make("other-host"),
                consumerId: hostId,
                baseUrl: "https://fallback.example.ts.net/api/inference",
                alternates: [],
              },
            });
            const previousPiConfig = (yield* settings.getSettings).providerInstances[piId]?.config;
            if (!isInferenceProviderConfig(previousPiConfig))
              throw new Error("Expected an independent Pi route");
            const unrelatedRequests = remoteCatalogKeys.length;
            catalog = [...catalog, { id: "gpt-local-scoped", owned_by: "openai" }];
            yield* proxy.refreshModelCatalog(true, ProviderInstanceId.make("codex"));
            expect(activeCodexConfig).toMatchObject({
              customModels: expect.arrayContaining(["gpt-local-scoped"]),
            });
            const piConfig = (yield* settings.getSettings).providerInstances[piId]?.config;
            expect(isInferenceProviderConfig(piConfig) ? piConfig.inferenceModels : null).toEqual(
              previousPiConfig.inferenceModels,
            );
            expect(remoteCatalogKeys.length).toBe(unrelatedRequests);
            yield* proxy.manage({ operation: "removeRoute", instanceId: piId });
            remoteCatalogKeys.length = 0;
            catalog = initialCatalog;
            yield* proxy.manage({ operation: "check", state: "sign-in" });
            yield* proxy.bindRoutes(45678);
            configured = (yield* settings.getSettings).providerInstances[
              ProviderInstanceId.make("codex")
            ];
            expect(configured?.config).toMatchObject({
              inferenceBaseUrl: "http://127.0.0.1:45678/api/inference/linked/codex/host",
            });
            if (!isInferenceProviderConfig(configured?.config))
              throw new Error("Expected a rebound inference route");
            expect(yield* proxy.routeHealth(configured.config, local.key, "codex")).toMatchObject({
              availableDrivers: expect.arrayContaining(["codex"]),
            });
            yield* settings.updateProviderInstance({
              operation: "upsert",
              instanceId: ProviderInstanceId.make("codex"),
              instance: { ...configured!, enabled: false },
            });
            yield* proxy.manage({ operation: "check", state: "sign-in" });
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.enabled,
            ).toBe(false);
            yield* settings.updateProviderInstance({
              operation: "upsert",
              instanceId: ProviderInstanceId.make("codex"),
              instance: configured!,
            });
            const populatedCatalog = catalog;
            catalog = [];
            yield* proxy.manage({ operation: "removeAccount", name: "one.json" });
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({ inferenceEnabled: true, inferenceModels: [] });
            expect(activeCodexConfig).toMatchObject({ customModels: [] });
            catalog = populatedCatalog;
            yield* proxy.manage({ operation: "check", state: "sign-in" });
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")],
            ).toEqual(configured);
            expect(
              yield* proxy.connect({ ...connect, grant: issued }).pipe(Effect.flip),
            ).toHaveProperty("_tag", "InferenceProxyError");
            identity = peer.environmentId;
            peerId = peer.environmentId;
            expect(
              (yield* proxy.connect({ ...connect, grant: issued }).pipe(Effect.flip)).message,
            ).toContain("another T3 environment");
            expect(remoteCatalogKeys).toEqual([]);
            peerId = hostId;
            yield* proxy.connect({ ...connect, grant: issued });
            expect(remoteCatalogKeys).toEqual(["Bearer " + issued.key]);
            tailnetCatalogDown = true;
            yield* proxy.connect({ ...connect, grant: issued });
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({
              inferenceBaseUrl: expect.stringContaining("/api/inference/linked/codex/host"),
            });
            expect((yield* proxy.authorize(issued.key, hostId, "codex"))?.baseUrl).toContain(
              "192.168.1.12",
            );
            const directConfig = (yield* settings.getSettings).providerInstances[
              ProviderInstanceId.make("codex")
            ]?.config;
            if (!isInferenceProviderConfig(directConfig))
              throw new Error("Expected a direct inference route");
            expect(yield* proxy.routeHealth(directConfig, issued.key, "codex")).toMatchObject({
              availableDrivers: expect.arrayContaining(["codex"]),
            });
            const directCatalog = catalog;
            catalog = [...catalog, { id: "gpt-remote-new", owned_by: "openai" }];
            yield* TestClock.adjust("15 seconds");
            yield* proxy.refreshModelCatalog();
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({
              inferenceModels: expect.arrayContaining(["gpt-remote-new"]),
              inferenceKey: issued.key,
            });
            const requestsAfterRefresh = remoteCatalogKeys.length;
            yield* proxy.refreshModelCatalog();
            expect(remoteCatalogKeys).toHaveLength(requestsAfterRefresh);
            remoteCatalogUnavailable = true;
            yield* proxy.refreshModelCatalog(true);
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({ inferenceModels: expect.arrayContaining(["gpt-remote-new"]) });
            remoteCatalogUnavailable = false;
            catalog = directCatalog;
            tailnetCatalogDown = false;
            connectionDown = true;
            tailnetCatalogDown = true;
            yield* proxy.connect({
              ...connect,
              grant: issued,
              connection: { url: "https://pool.example.ts.net" },
            });
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({
              inferenceBaseUrl: expect.stringContaining("/api/inference/linked/codex/host"),
            });
            expect((yield* proxy.authorize(issued.key, hostId, "codex"))?.baseUrl).toContain(
              "192.168.1.12",
            );
            connectionDown = false;
            tailnetCatalogDown = false;
            const linkedGrant = { ...issued, baseUrl: "t3-environment:host", alternates: [] };
            expect(
              (yield* proxy.connect({ ...connect, grant: linkedGrant }).pipe(Effect.flip)).message,
            ).toContain("Connect to the inference host");
            linked = true;
            yield* proxy.registerFallback({
              ...connect,
              driver: "traex",
              grant: { ...linkedGrant, key: peerBridgeKey },
            });
            expect(
              yield* proxy.traexCandidates("resolve", consumerBridgeKey, "traex-test"),
            ).toEqual([
              {
                baseUrl: linkedUrl + "/api/inference/traex/host",
                key: peerBridgeKey,
                models: ["traex-test"],
              },
            ]);
            expect(
              yield* proxy.traexCandidates("resolve", consumerBridgeKey, "generic-codex-only"),
            ).toEqual([]);
            expect(yield* proxy.traexCandidates("host", peerBridgeKey)).toEqual([]);
            yield* proxy.connect({ ...connect, grant: linkedGrant });
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({
              inferenceBaseUrl: expect.stringContaining("/api/inference/linked/codex/host"),
            });
            expect(activeCodexConfig).toMatchObject({
              inferenceBaseUrl: expect.stringContaining("/api/inference/linked/codex/host"),
            });
            yield* proxy.bindRoutes(45678);
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({
              inferenceBaseUrl: expect.stringContaining(
                "127.0.0.1:45678/api/inference/linked/codex/host",
              ),
            });
            expect(yield* proxy.authorize("wrong-key", hostId)).toBeNull();
            expect(yield* proxy.authorize(issued.key, hostId, "claudeAgent")).toBeNull();
            expect(yield* proxy.authorize(issued.key, hostId)).toEqual({
              baseUrl: "http://127.0.0.1:23456/api/inference",
              key: issued.key,
            });
            linkedUrl = "http://127.0.0.1:34567";
            expect((yield* proxy.authorize(issued.key, hostId))?.baseUrl).toBe(
              "http://127.0.0.1:34567/api/inference",
            );
            connectionOverride = "http://127.0.0.1:23456";
            staleLinkedCatalog = true;
            yield* proxy.connect({
              ...connect,
              grant: linkedGrant,
              connection: { url: "http://127.0.0.1:23456" },
            });
            staleLinkedCatalog = false;
            connectionOverride = undefined;
            yield* proxy.connect({ ...connect, grant: linkedGrant });
            linked = false;
            expect(yield* proxy.authorize(issued.key, hostId).pipe(Effect.flip)).toHaveProperty(
              "_tag",
              "InferenceProxyError",
            );
            yield* proxy.connect({
              ...connect,
              grant: linkedGrant,
              connection: {
                url: "http://127.0.0.1:23456",
                ssh: {
                  alias: "host",
                  hostname: "host.local",
                  username: "user",
                  port: 22,
                },
              },
            });
            expect((yield* proxy.authorize(issued.key, hostId))?.baseUrl).toBe(
              "http://127.0.0.1:34567/api/inference",
            );
            connectionDown = true;
            expect(
              (yield* proxy
                .connect({
                  ...connect,
                  grant: issued,
                  connection: {
                    url: "http://127.0.0.1:23456",
                    ssh: {
                      alias: "host",
                      hostname: "host.local",
                      username: "user",
                      port: 22,
                    },
                  },
                })
                .pipe(Effect.flip)).message,
            ).toBe("SSH connection unavailable");
            connectionDown = false;
            const routes = (yield* proxy.status).routes;
            expect(routes).toHaveLength(1);
            peerId = EnvironmentId.make("other-host");
            connectionDown = true;
            const primaryCatalog = catalog;
            catalog = [
              { id: "codex-auto-review", owned_by: "openai" },
              { id: "fallback-only", owned_by: "openai" },
            ];
            yield* proxy.registerFallback({
              ...connect,
              grant: {
                ...issued,
                hostId: peerId,
                baseUrl: "https://fallback.example.ts.net/api/inference",
                alternates: [],
              },
            });
            catalog = primaryCatalog;
            fallbackCatalog = [
              { id: "codex-auto-review", owned_by: "openai" },
              { id: "fallback-only", owned_by: "openai" },
              { id: "gpt-fallback-new", owned_by: "openai" },
            ];
            yield* proxy.refreshModelCatalog(true);
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({
              inferenceHostId: hostId,
              inferenceModels: expect.arrayContaining(["office-model", "gpt-fallback-new"]),
            });
            expect(
              (yield* proxy.routeCandidates(issued.key, hostId, "codex", "gpt-fallback-new"))?.map(
                ({ hostId }) => hostId,
              ),
            ).toEqual([peerId]);
            expect(
              (yield* proxy.routeCandidates(issued.key, hostId, "codex", "codex-auto-review"))?.map(
                (candidate) => candidate.hostId,
              ),
            ).toEqual([peerId]);
            connectionDown = false;
            yield* TestClock.adjust("15 seconds");
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({
              inferenceHostId: hostId,
              inferenceBaseUrl: expect.stringContaining("/api/inference/linked/codex/host"),
            });
            expect(
              yield* proxy.routeCandidates(issued.key, hostId, "codex", "codex-auto-review"),
            ).toHaveLength(2);
            peerId = hostId;
            yield* proxy.connect({ ...connect, grant: issued });
            expect(yield* proxy.hasRoutePool(issued.key, hostId, "codex")).toBe(true);
            expect(yield* fs.readFileString(config.settingsPath)).not.toContain(issued.key);
            const setCodexConfigEnabled = (enabled: boolean) =>
              settings.reviseProviderInstance(ProviderInstanceId.make("codex"), (instance) => {
                if (!instance || !isInferenceProviderConfig(instance.config))
                  return Effect.die("Expected the connected Codex route");
                return Effect.succeed({
                  instance: {
                    ...instance,
                    enabled,
                    config: { ...instance.config, enabled },
                  },
                  result: undefined,
                });
              });
            yield* setCodexConfigEnabled(false);
            expect(yield* proxy.hasRoutePool(issued.key, hostId, "codex")).toBe(false);
            expect(yield* proxy.routeCandidates(issued.key, hostId, "codex")).toBeNull();
            expect(yield* proxy.authorize(issued.key, hostId, "codex")).toBeNull();
            expect((yield* proxy.status).routes.map((route) => route.instanceId)).not.toContain(
              ProviderInstanceId.make("codex"),
            );
            const inferenceProject = ProjectId.make("inference-project");
            const codexId = ProviderInstanceId.make("codex");
            yield* settings.updateSettings({
              projectSettingsOverrides: {
                [inferenceProject]: { providerInstances: { [codexId]: { enabled: true } } },
              },
            });
            expect(yield* proxy.hasRoutePool(issued.key, hostId, "codex")).toBe(true);
            expect(yield* proxy.routeCandidates(issued.key, hostId, "codex")).toHaveLength(1);
            expect(yield* proxy.authorize(issued.key, hostId, "codex")).not.toBeNull();
            expect((yield* proxy.status).routes.map((route) => route.instanceId)).toContain(
              codexId,
            );
            const oldCatalog = catalog;
            catalog = [...catalog, { id: "gpt-project-catalog-refresh", owned_by: "openai" }];
            yield* proxy.refreshModelCatalog(true);
            const projectOnlyCodex = (yield* settings.getSettings).providerInstances[codexId]!;
            expect(resolveProviderInstanceEnabled(projectOnlyCodex)).toBe(false);
            expect(projectOnlyCodex.config).toMatchObject({
              inferenceModels: expect.arrayContaining(["gpt-project-catalog-refresh"]),
            });
            expect(activeCodexEnabled).toBe(true);
            expect(activeCodexConfig).toMatchObject({
              setupMode: "inference",
              customModels: expect.arrayContaining(["gpt-project-catalog-refresh"]),
            });
            catalog = oldCatalog;
            yield* proxy.manage({
              operation: "removeRoute",
              instanceId: ProviderInstanceId.make("codex"),
            });
            expect(yield* proxy.routeCandidates(issued.key, hostId, "codex")).toBeNull();
            expect(yield* proxy.authorize(issued.key, hostId, "codex")).toBeNull();
            yield* proxy.connect({ ...connect, grant: issued, preserveProviderEnabled: true });
            const resumed = (yield* settings.getSettings).providerInstances[codexId]!;
            expect(resumed.enabled).toBe(false);
            expect(resumed.config).toMatchObject({ inferenceEnabled: true });
            expect(yield* proxy.hasRoutePool(issued.key, hostId, "codex")).toBe(true);
            yield* settings.updateSettings({
              projectSettingsOverrides: { [inferenceProject]: null },
            });
            yield* setCodexConfigEnabled(true);
            yield* proxy.connect({ ...connect, grant: issued });
            expect(yield* proxy.hasRoutePool(issued.key, hostId, "codex")).toBe(true);
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.config,
            ).toMatchObject({
              inferenceBaseUrl: expect.stringContaining("/api/inference/linked/codex/host"),
              inferenceModels: expect.arrayContaining(["codex-auto-review", "fallback-only"]),
            });
            expect(
              yield* proxy.routeCandidates(issued.key, hostId, "codex", "codex-auto-review"),
            ).toHaveLength(2);
            yield* proxy.recordRouteOutcome({
              driver: "codex",
              hostId,
              model: "codex-auto-review",
              status: 403,
            });
            expect(
              (yield* proxy.routeCandidates(issued.key, hostId, "codex", "codex-auto-review"))?.map(
                (candidate) => candidate.hostId,
              ),
            ).toEqual([EnvironmentId.make("other-host")]);
            const fallbackHealth = yield* proxy.health(issued.key, hostId, "codex");
            expect(fallbackHealth?.models).toContain("codex-auto-review");
            expect(fallbackHealth?.unavailableModels ?? []).not.toContain("codex-auto-review");
            yield* proxy.recordRouteOutcome({
              driver: "codex",
              hostId,
              model: "codex-auto-review",
              status: 200,
            });
            expect(
              yield* proxy.routeCandidates(issued.key, hostId, "codex", "codex-auto-review"),
            ).toHaveLength(2);
            yield* proxy.recordRouteOutcome({
              driver: "codex",
              hostId,
              model: "codex-auto-review",
              status: 429,
              retryAfterMs: "1200000",
              retryAfter: "60",
            });
            yield* TestClock.adjust("11 minutes");
            expect(
              (yield* proxy.routeCandidates(issued.key, hostId, "codex", "codex-auto-review"))?.map(
                (candidate) => candidate.hostId,
              ),
            ).toEqual([EnvironmentId.make("other-host")]);
            yield* proxy.recordRouteOutcome({
              driver: "codex",
              hostId,
              model: "codex-auto-review",
              status: 200,
            });
            const date = DateTime.toDateUtc(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 30 * 60_000),
            ).toUTCString();
            yield* proxy.recordRouteOutcome({
              driver: "codex",
              hostId,
              model: "codex-auto-review",
              status: 429,
              retryAfterMs: " ",
              retryAfter: date,
            });
            yield* TestClock.adjust("11 minutes");
            expect(
              (yield* proxy.routeCandidates(issued.key, hostId, "codex", "codex-auto-review"))?.map(
                (candidate) => candidate.hostId,
              ),
            ).toEqual([EnvironmentId.make("other-host")]);
            yield* proxy.recordRouteOutcome({
              driver: "codex",
              hostId,
              model: "codex-auto-review",
              status: 200,
            });
            yield* proxy.recordRouteOutcome({
              driver: "codex",
              hostId,
              model: "codex-auto-review",
              status: 429,
              retryAfterMs: "-100",
              retryAfter: "1200",
            });
            yield* TestClock.adjust("11 minutes");
            expect(
              (yield* proxy.routeCandidates(issued.key, hostId, "codex", "codex-auto-review"))?.map(
                (candidate) => candidate.hostId,
              ),
            ).toEqual([EnvironmentId.make("other-host")]);
            yield* proxy.recordRouteOutcome({
              driver: "codex",
              hostId,
              model: "codex-auto-review",
              status: 200,
            });
            yield* proxy.recordRouteOutcome({
              driver: "codex",
              hostId,
              model: "codex-auto-review",
              status: 429,
              retryAfterMs: "-100",
              retryAfter: "-1",
            });
            yield* TestClock.adjust("29 seconds");
            expect(
              (yield* proxy.routeCandidates(issued.key, hostId, "codex", "codex-auto-review"))?.map(
                (candidate) => candidate.hostId,
              ),
            ).toEqual([EnvironmentId.make("other-host")]);
            yield* TestClock.adjust("1 second");
            expect(
              yield* proxy.routeCandidates(issued.key, hostId, "codex", "codex-auto-review"),
            ).toHaveLength(2);
            const reissued = { ...issued, key: "reissued-primary-key" };
            yield* proxy.connect({ ...connect, grant: reissued });
            expect(yield* proxy.hasRoutePool(reissued.key, hostId, "codex")).toBe(true);
            expect(
              yield* proxy.routeCandidates(reissued.key, hostId, "codex", "codex-auto-review"),
            ).toHaveLength(1);
            yield* proxy.recordRouteOutcome({
              driver: "codex",
              hostId,
              model: "codex-auto-review",
              status: 503,
              retryAfter: "320",
            });
            yield* TestClock.adjust("319 seconds");
            expect(
              yield* proxy.routeCandidates(reissued.key, hostId, "codex", "codex-auto-review"),
            ).toEqual([]);
            yield* TestClock.adjust("1 second");
            expect(
              yield* proxy.routeCandidates(reissued.key, hostId, "codex", "codex-auto-review"),
            ).toHaveLength(1);
            expect(yield* proxy.authorize(issued.key, hostId, "codex")).toBeNull();
            peerId = EnvironmentId.make("other-host");
            yield* proxy.connect({
              ...connect,
              hostLabel: "Second",
              grant: { ...issued, hostId: peerId },
            });
            expect((yield* proxy.status).routes.map((r) => r.label)).toEqual(["Codex via Second"]);
            expect(yield* proxy.authorize(issued.key, hostId)).toBeNull();
            yield* proxy.manage({ operation: "removeRoute", instanceId: routes[0]!.instanceId });
            expect((yield* proxy.status).routes).toEqual([]);
            expect(activeCodexConfig).toMatchObject({
              setupMode: "existing",
              homePath: "/native/home",
              inferenceEnabled: false,
            });
            expect(
              (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex")]
                ?.enabled,
            ).toBe(true);
            expect(
              yield* proxy
                .manage({ operation: "removeRoute", instanceId: ProviderInstanceId.make("codex") })
                .pipe(Effect.flip),
            ).toHaveProperty("_tag", "InferenceProxyError");
            identity = hostId;
            yield* proxy.manage({ operation: "checkUpdate" }).pipe(Effect.flip);
            registryOffline = false;
            expect((yield* proxy.manage({ operation: "checkUpdate" })).update).toEqual({
              current: proxyVersion,
              available: "8.0.61",
            });
            const update = yield* proxy
              .manage({ operation: "update" })
              .pipe(Effect.flip, Effect.forkScoped);
            yield* Deferred.await(downloading);
            expect((yield* proxy.authorize(issued.key))?.key).toBeDefined();
            yield* Deferred.succeed(finishDownload, undefined);
            expect((yield* Fiber.join(update)).message).toContain("checksum");
            expect((yield* proxy.status).version).toBe(proxyVersion);
            expect(stops).toBe(0);
            const staleRuntime = runtime.replace(proxyVersion, "8.0.58");
            const otherPlatform = staleRuntime.replace("darwin-arm64", "linux-x64");
            yield* fs.makeDirectory(staleRuntime);
            yield* fs.makeDirectory(otherPlatform);
            const installed = runtime.replace(proxyVersion, "8.0.61");
            yield* fs.makeDirectory(installed, { recursive: true });
            yield* fs.writeFileString(installed + "/cli-proxy-api", "");
            rejectNextLaunch = true;
            yield* proxy.manage({ operation: "update" }).pipe(Effect.flip);
            expect(yield* proxy.status).toMatchObject({ running: true, version: proxyVersion });
            expect((yield* proxy.authorize(issued.key))?.key).toBeDefined();
            yield* proxy.manage({ operation: "update" });
            expect((yield* proxy.status).version).toBe("8.0.61");
            expect(yield* fs.exists(staleRuntime)).toBe(false);
            expect(yield* fs.exists(otherPlatform)).toBe(true);
            expect(yield* fs.exists(runtime)).toBe(true);
            return { grant: issued, oldPort: Number(new URL(local.baseUrl).port) };
          }).pipe(Effect.provide(service)),
        );
        expect(stops).toBe(3);
        const legacyConfig = config.stateDir + "/inference-proxy/config.yaml";
        expect(yield* fs.exists(configPath)).toBe(false);
        yield* NodeSocketServer.make({ host: "127.0.0.1", port: oldPort });
        yield* fs.writeFileString(legacyConfig, "occupied listener configuration");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const proxy = yield* InferenceProxy.InferenceProxy;
            expect((yield* proxy.status).routing).toMatchObject({
              strategy: "fill-first",
              sessionAffinity: false,
            });
            const restoredUrl = (yield* proxy.authorize(grant.key))!.baseUrl;
            expect(restoredUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
            expect(new URL(restoredUrl).port).not.toBe(String(oldPort));
            expect(yield* fs.readFileString(legacyConfig)).toBe("occupied listener configuration");
            yield* proxy.manage({ operation: "revoke", environmentId: peer.environmentId });
            expect(yield* proxy.authorize(grant.key)).toBeNull();
            expect(yield* proxy.traexCandidates("host", peerBridgeKey)).toBeNull();
            expect(yield* proxy.health(grant.key)).toBeNull();
            expect(
              yield* proxy.grant({ ...peer, automatic: true }).pipe(Effect.result),
            ).toMatchObject({ _tag: "Failure" });
            const restored = yield* proxy.grant(peer);
            expect(restored.key).not.toBe(grant.key);
            expect((yield* proxy.grant({ ...peer, automatic: true })).key).toBe(restored.key);
            expectRecovery = true;
            yield* Deferred.succeed(currentExit!, undefined);
            yield* TestClock.adjust("1 second");
            yield* Deferred.await(recovered);
            expect((yield* proxy.grant({ environmentId: hostId, label: "Local" })).baseUrl).toBe(
              restoredUrl,
            );
            yield* proxy.manage({ operation: "configure", enabled: false, sharing: false });
            expect((yield* proxy.status).consumers).toEqual([]);
            expect(Option.isSome(yield* state.get("inference-proxy-state"))).toBe(true);
          }).pipe(Effect.provide(service)),
        );
        expect(starts).toBe(5);
        expect(stops).toBe(5);
      }).pipe(
        Effect.provide(
          ServerSettings.layer.pipe(
            Layer.provideMerge(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layerTest())),
            Layer.provideMerge(SqlitePersistence.layerMemory),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-inference-test-" }),
            ),
            Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
    ),
);
