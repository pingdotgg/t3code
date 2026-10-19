// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Exercises native socket timing at the private IPC boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  codexChatGptProfileKey,
  makeCodexChatGptAuth,
  type CodexChatGptCredentials,
} from "./CodexChatGptAuth.ts";
import { makeCodexManagedTokenSource } from "./CodexManagedTokenSource.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";

const instanceId = ProviderInstanceId.make("codex-managed-token-source-test");
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const credentials = {
  clientId: "oaiapp_test",
  accessToken: "access-a",
  refreshToken: "refresh-a",
  expiresAt: Number.MAX_SAFE_INTEGER,
  earliestRefreshAt: null,
  scopes: ["chatgpt.tokens.use.direct"],
  subject: "subject-a",
  email: null,
  idToken: "identity-a",
  issuer: "https://auth.openai.com",
} satisfies CodexChatGptCredentials;

const request = (source: { readonly endpoint: string }, frame = "token\n") =>
  new Promise<string>((resolve) => {
    const socket = NodeNet.createConnection(source.endpoint);
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", finish);
  });

it.effect("serves only the launch profile through a private scoped IPC endpoint", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(credentials);
    const source = yield* makeCodexManagedTokenSource(instanceId, credentials, Ref.get(current));

    assert.equal(yield* Effect.promise(() => request(source, "wrong\n")), "");
    assert.equal(yield* Effect.promise(() => request(source)), "access-a");

    yield* Ref.set(current, { ...credentials, accessToken: "access-b" });
    assert.equal(yield* Effect.promise(() => request(source)), "access-b");

    yield* Ref.set(current, {
      ...credentials,
      idToken: "replacement-identity",
      accessToken: "must-not-leak",
    });
    assert.equal(yield* Effect.promise(() => request(source)), "");

    if (windowsHost) {
      assert.match(source.endpoint, /^\\\\\.\\pipe\\t3-code-managed-codex-/u);
    } else {
      const socket = yield* Effect.promise(() => NodeFSP.lstat(source.endpoint));
      const directory = yield* Effect.promise(() =>
        NodeFSP.lstat(NodePath.dirname(source.endpoint)),
      );
      assert.isTrue(socket.isSocket());
      assert.equal(socket.mode & 0o777, 0o600);
      assert.equal(directory.mode & 0o777, 0o700);
    }
  }).pipe(Effect.scoped),
);

it.effect("concurrent IPC reads rotate an expired token once and persist the new refresh", () =>
  Effect.gen(function* () {
    const data = new Map<string, Uint8Array>();
    const secrets = ServerSecretStore.ServerSecretStore.of({
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
    });
    let exchanges = 0;
    yield* Effect.gen(function* () {
      const expired = {
        ...credentials,
        accessToken: "expired-access",
        refreshToken: "once-only-refresh",
        expiresAt: 0,
      };
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
      yield* store.set(new TextEncoder().encode(JSON.stringify(expired)));
      const auth = yield* makeCodexChatGptAuth({ instanceId });
      const profileKey = codexChatGptProfileKey(expired);
      const source = yield* makeCodexManagedTokenSource(
        instanceId,
        expired,
        auth.accessForProfile(profileKey),
      );
      const responses = yield* Effect.all(
        [Effect.promise(() => request(source)), Effect.promise(() => request(source))],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(responses, ["rotated-access", "rotated-access"]);
      assert.equal(exchanges, 1);
      const saved = Option.getOrThrow(yield* auth.read);
      assert.equal(saved.accessToken, "rotated-access");
      assert.equal(saved.refreshToken, "rotated-refresh");
    }).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
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
            exchanges++;
            assert.equal(exchanges, 1, "a rotating refresh token must not be replayed");
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: "rotated-access",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
                token_type: "Bearer",
                scope: "chatgpt.tokens.use.direct",
              }),
            );
          }),
        ),
      ),
      Effect.provide(NodeServices.layer),
    );
  }).pipe(Effect.scoped),
);

it.effect("shares one in-flight credential read across concurrent helper requests", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const access = Effect.gen(function* () {
      reads++;
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      return credentials;
    });
    const source = yield* makeCodexManagedTokenSource(instanceId, credentials, access);
    const requests = yield* Effect.all(
      Array.from({ length: 8 }, () => Effect.promise(() => request(source))),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);

    yield* Deferred.await(entered);
    for (let turn = 0; turn < 5; turn++)
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve);
          }),
      );
    assert.equal(reads, 1);

    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(yield* Fiber.join(requests), Array(8).fill("access-a"));
  }).pipe(Effect.scoped),
);

it.effect("enforces an absolute handshake deadline even while a peer trickles bytes", () =>
  Effect.gen(function* () {
    const source = yield* makeCodexManagedTokenSource(
      instanceId,
      credentials,
      Effect.succeed(credentials),
    );
    const closedBeforeWatchdog = yield* Effect.promise(
      () =>
        new Promise<boolean>((resolve) => {
          const socket = NodeNet.createConnection(source.endpoint);
          let settled = false;
          let interval: NodeJS.Timeout | undefined;
          let watchdog: NodeJS.Timeout | undefined;
          const finish = (closed: boolean) => {
            if (settled) return;
            settled = true;
            if (interval !== undefined) NodeTimers.clearInterval(interval);
            if (watchdog !== undefined) NodeTimers.clearTimeout(watchdog);
            socket.destroy();
            resolve(closed);
          };
          socket.once("connect", () => {
            interval = NodeTimers.setInterval(() => {
              if (!socket.destroyed) socket.write("t");
            }, 500);
            watchdog = NodeTimers.setTimeout(() => finish(false), 7_000);
          });
          socket.once("close", () => finish(true));
          socket.once("error", () => finish(true));
        }),
    );
    assert.isTrue(closedBeforeWatchdog);
  }).pipe(Effect.scoped),
);

it.effect("profile-bound access rejects replacement before consuming its refresh token", () =>
  Effect.gen(function* () {
    const data = new Map<string, Uint8Array>();
    const secrets = ServerSecretStore.ServerSecretStore.of({
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
    });
    let exchanges = 0;
    yield* Effect.gen(function* () {
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
      yield* store.set(new TextEncoder().encode(JSON.stringify(credentials)));
      const auth = yield* makeCodexChatGptAuth({ instanceId });
      const source = yield* makeCodexManagedTokenSource(
        instanceId,
        credentials,
        auth.accessForProfile(codexChatGptProfileKey(credentials)),
      );
      yield* store.set(
        new TextEncoder().encode(
          JSON.stringify({
            ...credentials,
            idToken: "replacement-identity",
            accessToken: "replacement-access",
            refreshToken: "replacement-refresh",
            expiresAt: 0,
          }),
        ),
      );
      assert.equal(yield* Effect.promise(() => request(source)), "");
      assert.equal(exchanges, 0);
    }).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
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
            exchanges++;
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: "must-not-be-used",
                refresh_token: "must-not-be-used",
                expires_in: 3600,
                token_type: "Bearer",
                scope: "chatgpt.tokens.use.direct",
              }),
            );
          }),
        ),
      ),
      Effect.provide(NodeServices.layer),
    );
  }).pipe(Effect.scoped),
);

it.effect("finishes an admitted refresh after the helper disconnects", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const access = Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      yield* Deferred.succeed(completed, undefined);
      return { ...credentials, accessToken: "rotated-after-disconnect" };
    });
    const source = yield* makeCodexManagedTokenSource(instanceId, credentials, access);
    const pending = NodeNet.createConnection(source.endpoint);
    pending.on("error", () => {});
    pending.once("connect", () => pending.write("token\n"));

    yield* Deferred.await(entered);
    pending.destroy();
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(completed);
  }).pipe(Effect.scoped),
);

it.effect("scope shutdown drains an admitted credential refresh", () =>
  Effect.gen(function* () {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    let completed = false;
    const access = Effect.promise(
      () =>
        new Promise<CodexChatGptCredentials>((resolve) => {
          enter();
          release = () => {
            completed = true;
            resolve({ ...credentials, accessToken: "rotated-before-close" });
          };
        }),
    );
    const scope = yield* Scope.make();
    const source = yield* makeCodexManagedTokenSource(instanceId, credentials, access).pipe(
      Scope.provide(scope),
    );
    const pending = NodeNet.createConnection(source.endpoint);
    pending.on("error", () => {});
    pending.once("connect", () => pending.write("token\n"));
    yield* Effect.promise(() => entered);

    void NodeTimersPromises.setTimeout(50).then(release);
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(completed);
    pending.destroy();
  }),
);

it.effect("does not admit new credential reads after scope shutdown begins", () =>
  Effect.gen(function* () {
    let reads = 0;
    const scope = yield* Scope.make();
    const source = yield* makeCodexManagedTokenSource(
      instanceId,
      credentials,
      Effect.sync(() => {
        reads++;
        return credentials;
      }),
    ).pipe(Scope.provide(scope));
    const socket = NodeNet.createConnection(source.endpoint);
    socket.on("error", () => {});
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          socket.once("connect", resolve);
        }),
    );
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const shutdown = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    socket.write("token\n");
    yield* Fiber.join(shutdown);
    yield* Effect.promise(() => closed);
    assert.equal(reads, 0);
  }),
);

it.effect("scope shutdown drops requestless peers and removes the IPC endpoint", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const source = yield* makeCodexManagedTokenSource(
      instanceId,
      credentials,
      Effect.succeed(credentials),
    ).pipe(Scope.provide(scope));
    const socket = NodeNet.createConnection(source.endpoint);
    let unsolicitedBytes = 0;
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      unsolicitedBytes += chunk.length;
    });
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          socket.once("connect", resolve);
        }),
    );
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    yield* Scope.close(scope, Exit.void);
    yield* Effect.promise(() => closed);
    assert.equal(unsolicitedBytes, 0);

    if (!windowsHost) {
      const remains = yield* Effect.promise(() =>
        NodeFSP.lstat(NodePath.dirname(source.endpoint)).then(
          () => true,
          () => false,
        ),
      );
      assert.isFalse(remains);
    }
  }),
);

it.effect("closes the IPC listener with its owning scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const source = yield* makeCodexManagedTokenSource(
      instanceId,
      credentials,
      Effect.succeed(credentials),
    ).pipe(Scope.provide(scope));

    assert.equal(yield* Effect.promise(() => request(source)), "access-a");
    yield* Scope.close(scope, Exit.void);
    assert.equal(yield* Effect.promise(() => request(source)), "");
  }),
);
