// @effect-diagnostics nodeBuiltinImport:off - Disposable private IPC clients and file-store commit barrier.
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { CodexSettings, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import * as Broker from "./CodexManagedTokenBroker.ts";
import * as Protocol from "./CodexManagedTokenProtocol.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { withChatGptSessionLock } from "./CodexChatGptSessionLock.ts";
import { makeCodexManagedRuntime } from "./CodexManagedRuntime.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import { codexAppServerArgs } from "./codexLaunchArgs.ts";

const decodeSettings = Schema.decodeSync(CodexSettings);

const instanceId = ProviderInstanceId.make("codex-broker-test");
const environmentId = EnvironmentId.make("00000000-0000-4000-8000-000000000001");
const credentials = {
  clientId: "oaiapp_test",
  subject: "subject",
  idToken: "identity",
  accessToken: "old-access",
  refreshToken: "once-only-refresh",
  expiresAt: 0,
  earliestRefreshAt: null,
  scopes: ["chatgpt.tokens.use.direct"],
  email: null,
};
const connect = (endpoint: string) =>
  Effect.acquireRelease(
    Effect.callback<{ socket: NodeNet.Socket; closed: Promise<void> }, Error>((resume) => {
      const socket = NodeNet.createConnection(endpoint);
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.on("error", () => {});
      socket.once("error", (error) => resume(Effect.fail(error)));
      socket.once("connect", () => resume(Effect.succeed({ socket, closed })));
      return Effect.sync(() => {
        if (socket.connecting) socket.destroy();
      });
    }),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  );

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const oauthEntered = yield* Deferred.make<void>();
  const oauthRelease = yield* Deferred.make<void>();
  const revoked: string[] = [];
  let pauseOAuth = false;
  let exchanges = 0;
  const fileSystem: FileSystem.FileSystem = {
    ...fs,
    rename: (from, to) =>
      Effect.gen(function* () {
        if (from.endsWith(".tmp") && to.includes("provider-auth-")) {
          const text = yield* fs.readFileString(from);
          if (text.includes("rotated-refresh")) {
            assert.equal(exchanges, 1);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
        }
        yield* fs.rename(from, to);
      }),
  };
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.endsWith("openid-configuration"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            issuer: "https://auth.openai.com",
            authorization_endpoint: "https://auth.openai.com/authorize",
            token_endpoint: "https://auth.openai.com/token",
            jwks_uri: "https://auth.openai.com/jwks",
            revocation_endpoint: "https://auth.openai.com/revoke",
          }),
        );
      assert.equal(request.body._tag, "Uint8Array");
      const body =
        request.body._tag === "Uint8Array"
          ? new URLSearchParams(new TextDecoder().decode(request.body.body))
          : new URLSearchParams();
      if (request.url.endsWith("/revoke")) {
        revoked.push(body.get("token")!);
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }
      assert.equal(request.url, "https://auth.openai.com/token");
      assert.equal(body.get("refresh_token"), "once-only-refresh");
      exchanges++;
      assert.equal(exchanges, 1, "a consumed refresh may never be replayed");
      yield* Deferred.succeed(oauthEntered, undefined);
      if (pauseOAuth) yield* Deferred.await(oauthRelease);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          access_token: "new-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "chatgpt.tokens.use.direct",
        }),
      );
    }),
  );
  return yield* Effect.gen(function* () {
    const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
    yield* store.set(new TextEncoder().encode(JSON.stringify(credentials)));
    const auth = yield* makeCodexChatGptAuth({ instanceId });
    const profileKey = yield* auth.profileKey(credentials);
    const services = Context.omit(Scope.Scope)(
      yield* Effect.context<
        Exclude<
          Effect.Services<ReturnType<typeof makeCodexManagedRuntime>>,
          Broker.CodexManagedTokenBroker | CodexInstallation.CodexInstallation
        >
      >(),
    );
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
    const context = yield* Layer.buildWithScope(Broker.layer, scope);
    const broker = Context.get(context, Broker.CodexManagedTokenBroker);
    yield* Effect.addFinalizer(() =>
      Deferred.succeed(release, undefined).pipe(
        Effect.andThen(Deferred.succeed(oauthRelease, undefined)),
      ),
    );
    const request = JSON.stringify({ version: 1, instanceId, environmentId, profileKey }) + "\n";
    const installer = yield* Layer.build(
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-test-installation",
        acquire: () =>
          Effect.succeed({
            executablePath: "/mock/codex",
            source: "local" as const,
            version: "0.156.1",
            managedVersionDirectory: null,
          }),
      }),
    );
    const runtimeServices = Context.merge(
      Context.add(services, Broker.CodexManagedTokenBroker, broker),
      installer,
    );
    const clean = Effect.gen(function* () {
      assert.deepEqual(
        (yield* fs.readDirectory(config.secretsDir)).filter(
          (n) => n.endsWith(".tmp") || n.endsWith(".lock"),
        ),
        [],
      );
    });
    return {
      broker,
      scope,
      request,
      entered,
      release,
      oauthEntered,
      oauthRelease,
      auth,
      store,
      revoked,
      clean,
      exchanges: () => exchanges,
      pauseOAuth: () => {
        pauseOAuth = true;
      },
      freshRuntime: makeCodexManagedRuntime({
        instanceId,
        enabled: true,
        environment: {},
        config: decodeSettings({
          setupMode: "managed",
          homePath: NodePath.join(config.stateDir, "mock-codex-home"),
        }),
      }).pipe(Effect.provide(runtimeServices)),
      switchProfile: (ready: Deferred.Deferred<void>, proceed: Deferred.Deferred<void>) =>
        withChatGptSessionLock(
          config.secretsDir,
          store.binding.key,
          instanceId,
          Effect.gen(function* () {
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(proceed);
            yield* store.set(
              new TextEncoder().encode(
                JSON.stringify({
                  ...credentials,
                  subject: "new-profile",
                  idToken: "new-identity",
                  accessToken: "other-access",
                  refreshToken: "other-refresh",
                  expiresAt: Number.MAX_SAFE_INTEGER,
                }),
              ),
            );
          }),
        ),
    };
  }).pipe(
    Effect.provide(ServerSecretStore.layer),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(HttpClient.HttpClient, http),
  );
});
const fixture = makeFixture.pipe(
  Effect.flatMap((h) =>
    h.broker.endpoint.pipe(Effect.map((endpoint) => ({ ...h, broker: { ...h.broker, endpoint } }))),
  ),
);
const provide = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-broker-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

it.live.each(["post-oauth-pre-rename", "during-oauth"] as const)(
  "disconnect %s leaves admitted rotation owned by server",
  (stage) =>
    provide(
      Effect.gen(function* () {
        const h = yield* fixture;
        if (stage === "during-oauth") h.pauseOAuth();
        const client = yield* connect(h.broker.endpoint);
        client.socket.write(h.request);
        yield* Deferred.await(stage === "during-oauth" ? h.oauthEntered : h.entered);
        client.socket.destroy();
        yield* Effect.promise(() => client.closed);
        if (stage === "during-oauth") {
          yield* Deferred.succeed(h.oauthRelease, undefined);
          yield* Deferred.await(h.entered);
        }
        yield* Deferred.succeed(h.release, undefined);
        yield* h.broker.awaitIdle;
        assert.equal(Option.getOrThrow(yield* h.auth.read).refreshToken, "rotated-refresh");
        assert.equal((yield* h.auth.access).accessToken, "new-access");
        assert.equal(h.exchanges(), 1);
        yield* h.clean;
      }).pipe(Effect.scoped),
    ),
);

it.live("normal server close drains accepted commits before releasing listener resources", () =>
  provide(
    Effect.gen(function* () {
      const h = yield* fixture;
      const client = yield* connect(h.broker.endpoint);
      client.socket.write(h.request);
      yield* Deferred.await(h.entered);
      const close = yield* Scope.close(h.scope, Exit.void).pipe(Effect.forkChild);
      yield* Effect.promise(() => client.closed);
      assert.isUndefined(close.pollUnsafe());
      yield* Deferred.succeed(h.release, undefined);
      yield* Fiber.join(close);
      assert.equal(Option.getOrThrow(yield* h.auth.read).refreshToken, "rotated-refresh");
      yield* h.clean;
      if ((yield* HostProcess.Platform) !== "win32")
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.dirname(h.broker.endpoint)).then(
              () => true,
              () => false,
            ),
          ),
        );
    }).pipe(Effect.scoped),
  ),
);

it.live("logout during commit revokes the newest token and cannot resurrect credentials", () =>
  provide(
    Effect.gen(function* () {
      const h = yield* fixture;
      const client = yield* connect(h.broker.endpoint);
      client.socket.write(h.request);
      yield* Deferred.await(h.entered);
      const logout = yield* h.auth.controller.logout(Effect.void).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isUndefined(logout.pollUnsafe());
      client.socket.destroy();
      yield* Deferred.succeed(h.release, undefined);
      yield* Fiber.join(logout);
      yield* h.broker.awaitIdle;
      assert.deepEqual(h.revoked, ["rotated-refresh"]);
      assert.isTrue(Option.isNone(yield* h.auth.read));
      yield* h.clean;
    }).pipe(Effect.scoped),
  ),
);

it.live(
  "controller rebuild does not retire the server endpoint or old-session profile binding",
  () =>
    provide(
      Effect.gen(function* () {
        const h = yield* fixture;
        const controllerScope = yield* Scope.make();
        yield* h.store.set(
          new TextEncoder().encode(
            JSON.stringify({ ...credentials, expiresAt: Number.MAX_SAFE_INTEGER }),
          ),
        );
        const oldRuntime = yield* Scope.provide(controllerScope)(h.freshRuntime);
        const oldEffective = yield* Scope.provide(controllerScope)(oldRuntime.resolve);
        const table = codexAppServerArgs(oldEffective.config.launchArgs).find((arg) =>
          arg.startsWith("model_providers.openai_token_sharing_"),
        )!;
        const args: string[] = JSON.parse(/args=(\[.*\]),timeout_ms=/u.exec(table)![1]!);
        assert.equal(args.at(-4), h.broker.endpoint);
        const old = oldRuntime.auth;
        const parentScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(parentScope, exit));
        // Real auth controller semantics: admitted session survives controller closure.
        const admitted = yield* Scope.provide(parentScope)(
          old.controller.withAccess!(Effect.succeed("session")),
        );
        assert.equal(admitted, "session");
        yield* Scope.close(controllerScope, Exit.void);
        const replacement = yield* h.freshRuntime;
        assert.equal(replacement.homePath, oldRuntime.homePath);
        yield* h.store.set(new TextEncoder().encode(JSON.stringify(credentials)));
        const client = yield* connect(args.at(-4)!);
        client.socket.write(
          JSON.stringify({
            version: 1,
            instanceId: args.at(-3),
            environmentId: args.at(-2),
            profileKey: args.at(-1),
          }) + "\n",
        );
        yield* Deferred.await(h.entered);
        client.socket.destroy();
        yield* Deferred.succeed(h.release, undefined);
        yield* h.broker.awaitIdle;
        assert.equal((yield* h.auth.access).accessToken, "new-access");
        yield* h.clean;
      }).pipe(Effect.scoped),
    ),
);

it.live(
  "reconnect start closes admitted sessions; cancelling reconnect cannot cancel a broker commit",
  () =>
    provide(
      Effect.gen(function* () {
        const h = yield* fixture;
        const client = yield* connect(h.broker.endpoint);
        const sessionClosed = yield* Deferred.make<void>();
        yield* h.auth.controller.withAccess!(
          Effect.addFinalizer(() =>
            Effect.sync(() => client.socket.destroy()).pipe(
              Effect.andThen(Deferred.succeed(sessionClosed, undefined)),
            ),
          ),
        );
        client.socket.write(h.request);
        yield* Deferred.await(h.entered);
        const state = yield* h.auth.controller.start(
          "owner",
          Effect.void,
          "chatgpt",
          "http://localhost:7001/welcome",
          "client",
        );
        yield* Deferred.await(sessionClosed);
        yield* Effect.promise(() => client.closed);
        assert.isNotNull(state.flowId);
        yield* h.auth.controller.cancel("owner", state.flowId!);
        yield* Deferred.succeed(h.release, undefined);
        yield* h.broker.awaitIdle;
        assert.equal((yield* h.auth.access).refreshToken, "rotated-refresh");
        yield* h.clean;
      }).pipe(Effect.scoped),
    ),
);

it.live(
  "old-profile requests admitted during a locked profile switch fail closed after contention",
  () =>
    provide(
      Effect.gen(function* () {
        const h = yield* fixture;
        const ready = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const switching = yield* h.switchProfile(ready, proceed).pipe(Effect.forkChild);
        yield* Deferred.await(ready);
        const peers = yield* Effect.forEach(Array.from({ length: 16 }), () =>
          Effect.gen(function* () {
            const client = yield* connect(h.broker.endpoint);
            client.socket.write(h.request);
            let bytes = 0;
            client.socket.on("data", (chunk) => {
              bytes += chunk.length;
            });
            return { ...client, bytes: () => bytes };
          }),
        );
        const overflow = yield* connect(h.broker.endpoint);
        overflow.socket.write(h.request);
        yield* Effect.promise(() => overflow.closed);
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(switching);
        yield* Effect.forEach(peers, (p) => Effect.promise(() => p.closed));
        yield* h.broker.awaitIdle;
        assert.deepEqual(
          peers.map((p) => p.bytes()),
          peers.map(() => 0),
        );
        assert.equal(Option.getOrThrow(yield* h.auth.read).refreshToken, "other-refresh");
        assert.equal(h.exchanges(), 0);
        yield* h.clean;
      }).pipe(Effect.scoped),
    ),
);

it.live(
  "invalid, oversized, extra-operation, wrong-environment and disconnected partial requests receive zero token bytes",
  () =>
    provide(
      Effect.gen(function* () {
        const h = yield* fixture;
        for (const request of [
          "not json\n",
          "x".repeat(Protocol.REQUEST_BYTES + 1),
          h.request.replace('"version":1', '"version":2'),
          h.request.replace('"version":1', '"operation":"read-store","version":1'),
          h.request.replace(environmentId, "00000000-0000-4000-8000-000000000002"),
        ]) {
          const client = yield* connect(h.broker.endpoint);
          let bytes = 0;
          client.socket.on("data", (chunk) => {
            bytes += chunk.length;
          });
          client.socket.write(request);
          yield* Effect.promise(() => client.closed);
          assert.equal(bytes, 0);
        }
        const client = yield* connect(h.broker.endpoint);
        client.socket.write(h.request.slice(0, 10));
        client.socket.destroy();
        yield* Effect.promise(() => client.closed);
        yield* h.broker.awaitIdle;
        assert.equal(h.exchanges(), 0);
      }).pipe(Effect.scoped),
    ),
);

it.live(
  "requestless read-only peers expire with zero bytes; incomplete sockets are bounded",
  () =>
    provide(
      Effect.gen(function* () {
        const h = yield* fixture;
        const peers = yield* Effect.forEach(Array.from({ length: 32 }), () =>
          connect(h.broker.endpoint),
        );
        const overflow = yield* connect(h.broker.endpoint);
        yield* Effect.promise(() => overflow.closed);
        const byteCounts = peers.map(() => 0);
        peers.forEach((p, index) =>
          p.socket.on("data", (chunk) => {
            byteCounts[index]! += chunk.length;
          }),
        );
        yield* Effect.forEach(peers, (p) => Effect.promise(() => p.closed), {
          concurrency: "unbounded",
        });
        assert.deepEqual(
          byteCounts,
          peers.map(() => 0),
        );
        assert.equal(h.exchanges(), 0);
      }).pipe(Effect.scoped),
    ),
  15_000,
);

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "Unix endpoint is private and cleanup never removes unowned contents",
  () =>
    provide(
      Effect.gen(function* () {
        const h = yield* fixture;
        const directory = NodePath.dirname(h.broker.endpoint);
        const [parent, socket] = yield* Effect.promise(() =>
          Promise.all([NodeFSP.lstat(directory), NodeFSP.lstat(h.broker.endpoint)]),
        );
        assert.isFalse(parent.isSymbolicLink());
        assert.equal(parent.uid, yield* HostProcess.UserId);
        assert.equal(parent.mode & 0o777, 0o700);
        assert.isTrue(socket.isSocket());
        assert.equal(socket.mode & 0o777, 0o600);
        const sentinel = NodePath.join(directory, "not-the-brokers-file");
        yield* Effect.promise(() => NodeFSP.writeFile(sentinel, "keep"));
        yield* Scope.close(h.scope, Exit.void);
        assert.equal(yield* Effect.promise(() => NodeFSP.readFile(sentinel, "utf8")), "keep");
        yield* Effect.promise(async () => {
          await NodeFSP.unlink(sentinel);
          await NodeFSP.rmdir(directory);
        });
      }).pipe(Effect.scoped),
    ),
);

it.live.each(["error-event", "throw"] as const)(
  "unavailable IPC (%s) fails managed setup before rotating credentials, not root construction",
  (failure) =>
    provide(
      Effect.gen(function* () {
        const listenerError = new Error("private-listener-cause");
        const listen = vi.spyOn(NodeNet.Server.prototype, "listen").mockImplementation(function (
          this: NodeNet.Server,
        ) {
          if (failure === "throw") throw listenerError;
          queueMicrotask(() => this.emit("error", listenerError));
          return this;
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => listen.mockRestore()));
        const h = yield* makeFixture;
        const runtime = yield* h.freshRuntime;
        yield* Deferred.succeed(h.release, undefined);
        const result = yield* runtime.resolve.pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "ProviderSetupError");
          assert.equal(result.failure.operation, "runtime");
          assert.notInclude(result.failure.detail, "private-listener-cause");
          assert.notInclude(result.failure.message, "private-listener-cause");
          assert.nestedPropertyVal(result.failure, "cause._tag", "ManagedTokenBrokerStartError");
          assert.nestedPropertyVal(result.failure, "cause.cause", listenerError);
        }
        assert.equal(h.exchanges(), 0);
        assert.equal(Option.getOrThrow(yield* h.auth.read).refreshToken, "once-only-refresh");
        yield* h.clean;
      }).pipe(Effect.scoped),
    ),
);

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "long trusted Unix temp parent selects a short protected endpoint",
  () =>
    provide(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-startup-"));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
        );
        const long = NodePath.join(root, "x".repeat(90));
        yield* Effect.promise(() => NodeFSP.mkdir(long, { mode: 0o700 }));
        const tmpdir = vi.spyOn(NodeOS, "tmpdir").mockReturnValue(long);
        yield* Effect.addFinalizer(() => Effect.sync(() => tmpdir.mockRestore()));
        const h = yield* fixture;
        assert.isAtMost(Buffer.byteLength(h.broker.endpoint), 100);
        const canonical = yield* Effect.promise(() => NodeFSP.realpath("/tmp"));
        assert.equal(NodePath.dirname(NodePath.dirname(h.broker.endpoint)), canonical);
        const directory = yield* Effect.promise(() =>
          NodeFSP.lstat(NodePath.dirname(h.broker.endpoint)),
        );
        assert.equal(directory.uid, yield* HostProcess.UserId);
        assert.equal(directory.mode & 0o777, 0o700);
        assert.equal(
          (yield* Effect.promise(() => NodeFSP.lstat(h.broker.endpoint))).mode & 0o777,
          0o600,
        );
        yield* Scope.close(h.scope, Exit.void);
        assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(long)), []);
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.dirname(h.broker.endpoint)).then(
              () => true,
              () => false,
            ),
          ),
        );
      }).pipe(Effect.scoped),
    ),
);

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "failed Unix acquisition closes a bound listener and removes its directory before root close",
  () =>
    provide(
      Effect.gen(function* () {
        const chmod = NodeFSP.chmod;
        const endpoints: string[] = [];
        const permissions = vi.spyOn(NodeFSP, "chmod").mockImplementation(async (path, mode) => {
          if (String(path).endsWith("/s")) {
            endpoints.push(String(path));
            throw new Error("socket chmod unavailable");
          }
          return chmod(path, mode);
        });
        const listen = vi.spyOn(NodeNet.Server.prototype, "listen");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            permissions.mockRestore();
            listen.mockRestore();
          }),
        );
        const h = yield* makeFixture;
        assert.equal((yield* h.broker.endpoint.pipe(Effect.result))._tag, "Failure");
        assert.lengthOf(listen.mock.contexts, 1);
        assert.isFalse((listen.mock.contexts[0] as NodeNet.Server).listening);
        assert.lengthOf(endpoints, 1);
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.dirname(endpoints[0]!)).then(
              () => true,
              () => false,
            ),
          ),
        );
        yield* h.clean;
      }).pipe(Effect.scoped),
    ),
);

it.live("job overload rejects immediately without cancelling already admitted rotation", () =>
  provide(
    Effect.gen(function* () {
      const h = yield* fixture;
      const peers = yield* Effect.forEach(Array.from({ length: 16 }), () =>
        Effect.gen(function* () {
          const p = yield* connect(h.broker.endpoint);
          p.socket.write(h.request);
          return p;
        }),
      );
      yield* Deferred.await(h.entered);
      // A final connection is ordered after the first 16 complete frames on the
      // same event loop. Rejected EOF is the overload witness, not a sleep.
      const overflow = yield* connect(h.broker.endpoint);
      overflow.socket.write(h.request);
      yield* Effect.promise(() => overflow.closed);
      for (const p of peers) p.socket.destroy();
      yield* Deferred.succeed(h.release, undefined);
      yield* h.broker.awaitIdle;
      assert.equal(h.exchanges(), 1);
      yield* h.clean;
    }).pipe(Effect.scoped),
  ),
);
