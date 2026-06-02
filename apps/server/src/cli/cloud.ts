import { AuthRelayWriteScope, EnvironmentHttpApi } from "@t3tools/contracts";
import { RelayOkResponse } from "@t3tools/contracts/relay";
import * as Cloudflared from "@t3tools/shared/cloudflared";
import { DEFAULT_T3_RELAY_URL } from "@t3tools/shared/relayAuth";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CliState from "../cloud/CliState.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { CLOUD_LINKED_USER_ID, RELAY_URL_SECRET } from "../cloud/config.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironmentLive } from "../environment/Layers/ServerEnvironment.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

interface CloudCliStatus {
  readonly desired: boolean;
  readonly authenticated: boolean;
  readonly linked: boolean;
  readonly cloudUserId: string | null;
  readonly relayUrl: string | null;
  readonly cloudflared: Cloudflared.CloudflaredExecutableStatus;
}

function formatCloudflaredStatus(
  executable: Cloudflared.CloudflaredExecutableStatus,
): ReadonlyArray<string> {
  switch (executable.status) {
    case "available": {
      const source =
        executable.source === "path"
          ? "PATH"
          : executable.source === "managed"
            ? "managed install"
            : "configured override";
      return [
        `  cloudflared: available via ${source}`,
        `    Path: ${executable.executablePath}`,
        `    Version: ${executable.version}`,
      ];
    }
    case "missing":
      return [`  cloudflared: not installed (managed version ${executable.version})`];
    case "unsupported":
      return [
        `  cloudflared: unsupported on ${executable.platform}-${executable.arch}`,
        `    Managed version: ${executable.version}`,
      ];
  }
}

function formatCloudStatus(status: CloudCliStatus, options?: { readonly json?: boolean }): string {
  if (options?.json) {
    return JSON.stringify(status, null, 2);
  }

  const provisioned = status.linked
    ? "provisioned"
    : status.desired && status.authenticated
      ? "pending server startup"
      : "not provisioned";
  const nextStep = !status.authenticated
    ? "Run `t3 cloud link` to authorize and enable cloud exposure."
    : !status.desired
      ? "Run `t3 cloud link` to enable cloud exposure."
      : !status.linked
        ? "Start T3 to provision the environment link and launch its managed tunnel."
        : undefined;

  return [
    "T3 Cloud",
    `  Exposure: ${status.desired ? "enabled" : "disabled"}`,
    `  Authorization: ${status.authenticated ? "stored credential" : "missing"}`,
    `  Environment link: ${provisioned}`,
    `  Relay: ${status.relayUrl ?? "not provisioned"}`,
    ...formatCloudflaredStatus(status.cloudflared),
    ...(nextStep ? ["", `Next: ${nextStep}`] : []),
  ].join("\n");
}

const CLOUD_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(5);

const withCloudCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuthShape,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: [AuthRelayWriteScope],
      subject: "cloud-cli",
      label: "t3 cloud cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

type LiveCloudActionResult =
  | { readonly status: "not-running" }
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly cause: unknown };

const runLiveCloudAction = Effect.fn("cloud.cli.run_live_action")(function* (
  action: "reconcile" | "unlink",
) {
  const config = yield* ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return { status: "not-running" } satisfies LiveCloudActionResult;
  }

  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const result = yield* Effect.exit(
    withCloudCliSessionToken(environmentAuth, (token) =>
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const client = yield* HttpApiClient.makeWith(EnvironmentHttpApi, {
          baseUrl: runtimeState.value.origin,
          httpClient,
        });
        return yield* action === "reconcile"
          ? client.cloud.reconcile({ headers: { authorization: `Bearer ${token}` } })
          : client.cloud.unlink({ headers: { authorization: `Bearer ${token}` } });
      }).pipe(Effect.timeout(CLOUD_CLI_LIVE_SERVER_TIMEOUT)),
    ),
  );
  return Exit.isSuccess(result)
    ? ({ status: "succeeded" } satisfies LiveCloudActionResult)
    : ({ status: "failed", cause: result.cause } satisfies LiveCloudActionResult);
});

type RelayUnlinkResult =
  | { readonly status: "not-authenticated" }
  | { readonly status: "revoked" }
  | { readonly status: "not-linked" };

const unlinkRelayEnvironment = Effect.fn("cloud.cli.unlink_relay_environment")(function* () {
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  const token = yield* tokens.getExisting;
  if (Option.isNone(token)) {
    return { status: "not-authenticated" } satisfies RelayUnlinkResult;
  }

  const environment = yield* ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const relayUrl = (yield* Config.string("T3_RELAY_URL").pipe(
    Config.withDefault(DEFAULT_T3_RELAY_URL),
    Effect.orDie,
  )).replace(/\/+$/u, "");
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.delete(
    `${relayUrl}/v1/client/environment-links/${encodeURIComponent(environmentId)}`,
  ).pipe(
    HttpClientRequest.bearerToken(token.value.accessToken),
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayOkResponse)),
  );
  return response.ok
    ? ({ status: "revoked" } satisfies RelayUnlinkResult)
    : ({ status: "not-linked" } satisfies RelayUnlinkResult);
});

const disconnectCloud = Effect.fn("cloud.cli.disconnect")(function* (options: {
  readonly clearAuthorization: boolean;
}) {
  yield* CliState.setCliDesiredCloudLink(false);
  const liveResult = yield* runLiveCloudAction("unlink");
  const relayResult = yield* Effect.exit(unlinkRelayEnvironment());
  yield* CliState.clearPersistedCloudLink;

  if (options.clearAuthorization) {
    const tokens = yield* CliTokenManager.CloudCliTokenManager;
    yield* tokens.clear;
  }

  if (liveResult.status === "failed") {
    yield* Console.warn(
      `T3 Cloud exposure is disabled, but the running server could not stop its tunnel: ${String(liveResult.cause)}\nRestart that server to stop the connector.`,
    );
  } else {
    yield* Console.log("T3 Cloud exposure is disabled locally.");
  }

  if (Exit.isFailure(relayResult)) {
    yield* Console.warn(
      options.clearAuthorization
        ? `Could not revoke the relay-side environment record before signing out: ${String(relayResult.cause)}\nThe stored CLI authorization was still removed locally.`
        : `Could not revoke the relay-side environment record yet: ${String(relayResult.cause)}\nRun \`t3 cloud unlink\` again when the relay is reachable.`,
    );
  } else if (relayResult.value.status === "revoked") {
    yield* Console.log("Revoked the relay-side environment record.");
  }

  if (options.clearAuthorization) {
    yield* Console.log("Signed out of T3 Cloud locally.");
  }
});

const runCloudCommand = <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<
    A,
    E,
    | ServerSecretStore.ServerSecretStore
    | CliTokenManager.CloudCliTokenManager
    | Cloudflared.CloudflaredExecutable
    | EnvironmentAuth.EnvironmentAuth
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | ServerConfig
    | ServerEnvironment
  >,
  options?: {
    readonly quietLogs?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
    const runtimeLayer = Layer.mergeAll(
      ServerSecretStore.layer,
      CliTokenManager.layer.pipe(Layer.provide(ServerSecretStore.layer)),
      Cloudflared.layer({ baseDir: config.baseDir }),
      EnvironmentAuth.runtimeLayer,
      ServerEnvironmentLive,
    ).pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(Layer.succeed(ServerConfig, config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );
    return yield* run.pipe(Effect.provide(runtimeLayer));
  });

const cloudLoginCommand = Command.make("login", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Authorize the T3 Cloud CLI without enabling cloud exposure."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        yield* tokens.get;
        yield* Console.log("Signed in to T3 Cloud.");
      }),
    ),
  ),
);

const cloudLinkCommand = Command.make("link", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Authorize this environment for T3 Cloud and expose it on next start."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const cloudflared = yield* Cloudflared.CloudflaredExecutable;
        const executable = yield* cloudflared.resolve;
        const installed =
          executable.status === "available" ? executable : yield* cloudflared.install;
        yield* Console.log(
          `Using cloudflared ${installed.version} from ${installed.executablePath}.`,
        );

        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        yield* tokens.get;
        yield* CliState.setCliDesiredCloudLink(true);

        const liveResult = yield* runLiveCloudAction("reconcile");
        if (liveResult.status === "succeeded") {
          yield* Console.log("T3 Cloud is linked and the running server is exposing its tunnel.");
        } else if (liveResult.status === "failed") {
          yield* Console.warn(
            `T3 Cloud is linked, but the running server could not expose its tunnel yet: ${String(liveResult.cause)}\nThe server will retry the next time it starts.`,
          );
        } else {
          yield* Console.log(
            "T3 Cloud is linked. The next time T3 starts, it will expose a managed tunnel.",
          );
        }
      }),
    ),
  ),
);

const cloudStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show persisted T3 Cloud and cloudflared state."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const cloudflared = yield* Cloudflared.CloudflaredExecutable;
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        const [desired, authenticated, cloudUserId, relayUrl, executable] = yield* Effect.all(
          [
            CliState.readCliDesiredCloudLink,
            tokens.hasCredential,
            secrets.get(CLOUD_LINKED_USER_ID),
            secrets.get(RELAY_URL_SECRET),
            cloudflared.resolve,
          ],
          { concurrency: "unbounded" },
        );
        const status: CloudCliStatus = {
          desired,
          authenticated,
          linked: cloudUserId !== null,
          cloudUserId: cloudUserId ? bytesToString(cloudUserId) : null,
          relayUrl: relayUrl ? bytesToString(relayUrl) : null,
          cloudflared: executable,
        };
        yield* Console.log(formatCloudStatus(status, { json: flags.json }));
      }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const cloudUnlinkCommand = Command.make("unlink", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Disable T3 Cloud exposure while retaining the stored authorization."),
  Command.withHandler((flags) =>
    runCloudCommand(flags, disconnectCloud({ clearAuthorization: false })),
  ),
);

const cloudLogoutCommand = Command.make("logout", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Disable T3 Cloud exposure and clear the stored CLI authorization."),
  Command.withHandler((flags) =>
    runCloudCommand(flags, disconnectCloud({ clearAuthorization: true })),
  ),
);

export const cloudCommand = Command.make("cloud").pipe(
  Command.withDescription("Manage headless T3 Cloud exposure."),
  Command.withSubcommands([
    cloudLoginCommand,
    cloudLinkCommand,
    cloudStatusCommand,
    cloudUnlinkCommand,
    cloudLogoutCommand,
  ]),
);
