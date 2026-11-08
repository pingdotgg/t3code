import { createCloudSandboxDriver, ensureCloudSandboxReady } from "@t3tools/cloud-sandbox";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  SshServerHomeKey,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  ManagedCloudSandboxContext,
  MANAGED_CLOUD_SOURCE_PORT,
  type CloudSandboxDriverKind,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NetService from "@t3tools/shared/Net";
import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SshAuth from "@t3tools/ssh/auth";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  resolveSshCommand,
  runSshCommand,
  shellSingleQuote,
} from "@t3tools/ssh/command";
import { SshEnvironmentManager } from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { CloudSandboxManagerError } from "./CloudSandboxStore.ts";
import packageJson from "../../package.json" with { type: "json" };

export const cloudSandboxCliRunner = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const releaseBaseUrl = environment[CLI_RELEASE_BASE_URL_ENV]?.trim();
  return {
    archiveVersion: packageJson.version,
    ...(releaseBaseUrl ? { releaseBaseUrl } : {}),
  };
});
export const cloudSandboxSourceProbe = {
  remoteCommandArgs: ["sh", "-s"],
  stdin: `curl -fsS --max-time 2 http://127.0.0.1:${MANAGED_CLOUD_SOURCE_PORT}/.well-known/t3/environment >/dev/null\n`,
  batchMode: "yes",
} as const;

export interface CloudSandboxTransportConnection {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly pairingToken: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
}
export interface CloudSandboxTransportInput {
  readonly resourceId: string;
  readonly driverKind: CloudSandboxDriverKind;
  readonly apiKey: string;
  readonly sandboxId: string;
  readonly parentSandboxId: string | null;
  readonly allowResume: boolean;
  readonly expectedEnvironmentId: EnvironmentId | null;
  readonly context: ManagedCloudSandboxContext;
  readonly enableLinkedEnvironments: boolean;
}
export class CloudSandboxTransport extends Context.Service<
  CloudSandboxTransport,
  {
    readonly connect: (
      input: CloudSandboxTransportInput,
    ) => Effect.Effect<CloudSandboxTransportConnection, CloudSandboxManagerError>;
    readonly disconnect: (resourceId: string) => Effect.Effect<void>;
    readonly isConnected: (resourceId: string) => Effect.Effect<boolean, CloudSandboxManagerError>;
    readonly withConnection: <A, E, R>(
      resourceId: string,
      effect: (target: DesktopSshEnvironmentTarget) => Effect.Effect<A, E, R | Scope.Scope>,
    ) => Effect.Effect<A, E | CloudSandboxManagerError, Exclude<R, Scope.Scope>>;
    readonly pairingToken: (resourceId: string) => Effect.Effect<string, CloudSandboxManagerError>;
  }
>()("t3/cloudSandbox/CloudSandboxTransport") {}
const isManagerError = Schema.is(CloudSandboxManagerError);
const encodeContext = Schema.encodeEffect(Schema.fromJsonString(ManagedCloudSandboxContext));
const SSH_HOST_PUBLIC_KEY_PATTERN =
  /^[A-Za-z0-9._-]+(?:@[A-Za-z0-9.-]+)?\s+[A-Za-z0-9+/=]+(?:\s+[^\r\n]+)?$/u;
const parseSshHostPublicKey = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("@") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    !SSH_HOST_PUBLIC_KEY_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
};
const resolveSshKeygenCommand = Effect.map(HostProcess.Platform, (platform) =>
  platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen",
);
export const cloudSandboxSetupPayload = (
  input: Pick<
    CloudSandboxTransportInput,
    "enableLinkedEnvironments" | "parentSandboxId" | "expectedEnvironmentId"
  >,
  hash: string,
  parentHash: string | null,
  context: string,
) => {
  const home = `$HOME/.t3/environments/${hash}`;
  return `set -eu\numask 077\n${parentHash === null || input.expectedEnvironmentId !== null ? "" : `if [ -d "$HOME/.t3/environments/${parentHash}" ]; then find "$HOME/.t3/environments/${parentHash}" -mindepth 1 -maxdepth 1 ! -name worktrees -exec rm -rf {} +; fi\n`}${
    input.enableLinkedEnvironments && input.expectedEnvironmentId === null
      ? `if [ ! -e "${home}" ]; then
mkdir -p "${home}/userdata"
printf '%s' '{"linkedEnvironmentsEnabled":true}' > "${home}/userdata/settings.json"
fi
`
      : ""
  }mkdir -p "${home}/userdata"\nprintf %s ${shellSingleQuote(context)} > "${home}/managed-cloud.json"\n\n`;
};
const runtime = Effect.context<
  | FileSystem.FileSystem
  | Path.Path
  | Digest.Digest
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | NetService.NetService
  | SshAuth.SshPasswordPrompt
>();
export const make = Effect.gen(function* () {
  const captured = yield* runtime;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const manager = yield* SshEnvironmentManager;
  const scope = yield* Scope.Scope;
  const sshKeygenCommand = yield* resolveSshKeygenCommand;
  const locks = yield* KeyedLock.make<string>();
  const entries = new Map<
    string,
    {
      target: DesktopSshEnvironmentTarget;
      scope: Scope.Closeable;
      running: Effect.Effect<boolean>;
      ready: Effect.Effect<boolean>;
    }
  >();
  const pendingTargets = new Map<string, DesktopSshEnvironmentTarget>();
  const directory = path.join(config.baseDir, "cloud-sandbox-ssh");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const identityFile = path.join(directory, "id_ed25519");
  const publicKeyFile = `${identityFile}.pub`;
  const ensureKey = locks.withLock(
    "ssh-key",
    Effect.gen(function* () {
      const hasPrivate = yield* fs.exists(identityFile);
      const hasPublic = yield* fs.exists(publicKeyFile);
      if (!hasPrivate || !hasPublic) {
        if (hasPrivate) yield* fs.remove(identityFile, { force: true });
        if (hasPublic) yield* fs.remove(publicKeyFile, { force: true });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(sshKeygenCommand, [
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-f",
                identityFile,
              ]),
            );
            if ((yield* child.exitCode) !== 0)
              return yield* new CloudSandboxManagerError({ reason: "transport" });
          }),
        );
      }
      return yield* fs.readFileString(publicKeyFile);
    }),
  );
  const disconnect = Effect.fn("CloudSandboxTransport.disconnect")(function* (resourceId: string) {
    const entry = entries.get(resourceId);
    const target = entry?.target ?? pendingTargets.get(resourceId);
    if (entry) yield* Scope.close(entry.scope, Exit.void);
    entries.delete(resourceId);
    pendingTargets.delete(resourceId);
    if (target) yield* manager.releaseEnvironment(target);
  }, Effect.provide(captured));
  const issuePairingToken = Effect.fn("CloudSandboxTransport.issuePairingToken")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const bootstrap = yield* manager.ensureEnvironment(target, { issuePairingToken: true });
    if (!bootstrap.pairingToken)
      return yield* new CloudSandboxManagerError({ reason: "transport" });
    return bootstrap.pairingToken;
  }, Effect.provide(captured));
  const connect = Effect.fn("CloudSandboxTransport.connect")(
    function* (input: CloudSandboxTransportInput) {
      const client = yield* HttpClient.HttpClient;
      const digest = yield* Digest.Digest;
      const publicKey = yield* ensureKey;
      const driver = yield* createCloudSandboxDriver(input.driverKind, {
        apiKey: input.apiKey,
        httpClient: client,
      });
      yield* ensureCloudSandboxReady(driver, input.sandboxId, input.allowResume);
      const ssh = yield* driver.registerSshKey(input.sandboxId, publicKey.trim());
      const hostKey = parseSshHostPublicKey(ssh.hostKey);
      if (hostKey === null) {
        return yield* new CloudSandboxManagerError({ reason: "transport" });
      }
      const hash = Hex.encode(
        yield* digest.digest(
          Digest.sha256,
          new TextEncoder().encode(`${driver.kind}:${input.sandboxId}`),
        ),
      );
      const hostKeyAlias = `t3-cloud-${hash}`;
      const knownHostsFile = path.join(directory, `${hash}.known-hosts`);
      yield* fs.writeFileString(knownHostsFile, `${hostKeyAlias} ${hostKey}\n`, {
        mode: 0o600,
      });
      const target = {
        ...ssh.target,
        identityFile,
        knownHostsFile,
        hostKeyAlias,
        serverHomeKey: SshServerHomeKey.make(hash),
      };
      pendingTargets.set(input.resourceId, target);
      const parentHash =
        input.parentSandboxId === null
          ? null
          : Hex.encode(
              yield* digest.digest(
                Digest.sha256,
                new TextEncoder().encode(`${driver.kind}:${input.parentSandboxId}`),
              ),
            );
      if (parentHash === hash) return yield* new CloudSandboxManagerError({ reason: "ownership" });
      const context = yield* encodeContext(input.context);
      yield* runSshCommand(target, {
        remoteCommandArgs: ["sh", "-s"],
        stdin: cloudSandboxSetupPayload(input, hash, parentHash, context),
        batchMode: "yes",
      });
      const bootstrap = yield* manager.ensureEnvironment(target, { issuePairingToken: true });
      const api = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: bootstrap.httpBaseUrl });
      const descriptor = yield* api.metadata.descriptor();
      if (
        input.expectedEnvironmentId !== null &&
        descriptor.environmentId !== input.expectedEnvironmentId
      )
        return yield* new CloudSandboxManagerError({ reason: "transport" });
      if (!bootstrap.pairingToken)
        return yield* new CloudSandboxManagerError({ reason: "transport" });
      const token = yield* api.auth.token({
        headers: {},
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: bootstrap.pairingToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        },
      });
      const previous = entries.get(input.resourceId);
      if (previous) yield* Scope.close(previous.scope, Exit.void);
      const reverseScope = yield* Scope.fork(scope);
      const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      const controllerPort = Option.isSome(runtimeState) ? runtimeState.value.port : config.port;
      if (controllerPort <= 0) return yield* new CloudSandboxManagerError({ reason: "transport" });
      const args = [
        ...baseSshArgs(target, { batchMode: "yes" }),
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-N",
        "-R",
        `127.0.0.1:${MANAGED_CLOUD_SOURCE_PORT}:127.0.0.1:${controllerPort}`,
        "--",
        yield* buildSshHostSpecEffect(target),
      ];
      const reverse = yield* spawner
        .spawn(ChildProcess.make(yield* resolveSshCommand, args))
        .pipe(Effect.provideService(Scope.Scope, reverseScope));
      entries.set(input.resourceId, {
        target,
        scope: reverseScope,
        running: reverse.isRunning.pipe(Effect.orElseSucceed(() => false)),
        ready: api.metadata.descriptor().pipe(
          Effect.map((current) => current.environmentId === descriptor.environmentId),
          Effect.orElseSucceed(() => false),
        ),
      });
      yield* runSshCommand(target, cloudSandboxSourceProbe).pipe(
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 20 }),
      );
      pendingTargets.delete(input.resourceId);
      return {
        httpBaseUrl: bootstrap.httpBaseUrl,
        bearerToken: token.access_token,
        pairingToken: yield* issuePairingToken(target),
        environmentId: descriptor.environmentId,
        label: descriptor.label,
      };
    },
    Effect.provide(captured),
    Effect.mapError((cause) =>
      isManagerError(cause) ? cause : new CloudSandboxManagerError({ reason: "transport", cause }),
    ),
  );
  const isConnected = Effect.fn("CloudSandboxTransport.isConnected")(function* (
    resourceId: string,
  ) {
    const entry = entries.get(resourceId);
    if (!entry || !(yield* entry.running) || !(yield* entry.ready)) return false;
    return yield* runSshCommand(entry.target, cloudSandboxSourceProbe).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  }, Effect.provide(captured));
  return CloudSandboxTransport.of({
    isConnected,
    withConnection: Effect.fn("CloudSandboxTransport.withConnection")((resourceId, effect) =>
      locks.withLock(
        resourceId,
        Effect.gen(function* () {
          if (!(yield* isConnected(resourceId)))
            return yield* new CloudSandboxManagerError({ reason: "transport" });
          const entry = entries.get(resourceId);
          if (!entry) return yield* new CloudSandboxManagerError({ reason: "transport" });
          return yield* effect(entry.target).pipe(Effect.provideService(Scope.Scope, entry.scope));
        }),
      ),
    ),
    connect: Effect.fn("CloudSandboxTransport.ensureConnected")((input) =>
      locks.withLock(
        input.resourceId,
        connect(input).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? disconnect(input.resourceId).pipe(Effect.ignore) : Effect.void,
          ),
        ),
      ),
    ),
    disconnect: Effect.fn("CloudSandboxTransport.disconnectLocked")((id) =>
      locks.withLock(id, disconnect(id)),
    ),
    pairingToken: Effect.fn("CloudSandboxTransport.pairingToken")(function* (resourceId) {
      const entry = entries.get(resourceId);
      if (!entry) return yield* new CloudSandboxManagerError({ reason: "transport" });
      return yield* issuePairingToken(entry.target).pipe(
        Effect.mapError((cause) =>
          isManagerError(cause)
            ? cause
            : new CloudSandboxManagerError({ reason: "transport", cause }),
        ),
      );
    }, Effect.provide(captured)),
  });
});
export const layer = Layer.effect(CloudSandboxTransport, make).pipe(
  Layer.provide(SshEnvironmentManager.layer({ resolveCliRunner: cloudSandboxCliRunner })),
  Layer.provide(SshAuth.SshPasswordPrompt.disabledLayer),
);
