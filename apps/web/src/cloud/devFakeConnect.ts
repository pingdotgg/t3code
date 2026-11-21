import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  EnvironmentMachineKind,
  ExecutionEnvironmentPlatformArch,
  ExecutionEnvironmentPlatformOs,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  RelayManagedEndpointProviderKind,
  type RelayClientEnvironmentRecord,
  type RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Dev-only: stages T3 Connect account machines for launch videos without a Connect account.
const DEV_FAKE_CONNECT_STORAGE_KEY = "t3code:dev:fake-t3-connect";

const DevFakeConnectEnvironment = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  online: Schema.Boolean,
  machine: Schema.optionalKey(EnvironmentMachineKind),
  os: Schema.optionalKey(ExecutionEnvironmentPlatformOs),
  arch: Schema.optionalKey(ExecutionEnvironmentPlatformArch),
  serverVersion: Schema.optionalKey(TrimmedNonEmptyString),
  providerKind: Schema.optionalKey(RelayManagedEndpointProviderKind),
});

const DevFakeConnect = Schema.Struct({
  account: Schema.Struct({ email: TrimmedNonEmptyString }),
  environments: Schema.Array(DevFakeConnectEnvironment),
});
export type DevFakeConnect = typeof DevFakeConnect.Type;

export const decodeDevFakeConnect = Schema.decodeUnknownOption(
  Schema.fromJsonString(DevFakeConnect),
);

function readDevFakeConnect(): DevFakeConnect | null {
  try {
    const raw = window.localStorage.getItem(DEV_FAKE_CONNECT_STORAGE_KEY);
    return raw === null ? null : Option.getOrNull(decodeDevFakeConnect(raw));
  } catch {
    return null;
  }
}

/** The staged account, or null outside dev or without the localStorage key. */
export const devFakeConnect: DevFakeConnect | null =
  import.meta.env.DEV && typeof window !== "undefined" ? readDevFakeConnect() : null;

export const DEV_FAKE_CONNECT_TOKEN = "dev-fake-t3-connect";

const CHECKED_AT = "2026-01-01T00:00:00.000Z";

function environmentRecord(
  environment: DevFakeConnect["environments"][number],
): RelayClientEnvironmentRecord {
  const host = `${environment.environmentId}.fake-connect.invalid`;
  return {
    environmentId: environment.environmentId as RelayClientEnvironmentRecord["environmentId"],
    label: environment.label,
    endpoint: {
      httpBaseUrl: `https://${host}`,
      wsBaseUrl: `wss://${host}`,
      providerKind: environment.providerKind ?? "t3_relay",
    },
    linkedAt: CHECKED_AT,
  };
}

function environmentStatus(
  environment: DevFakeConnect["environments"][number],
): RelayEnvironmentStatusResponse {
  const record = environmentRecord(environment);
  return {
    environmentId: record.environmentId,
    endpoint: record.endpoint,
    status: environment.online ? "online" : "offline",
    checkedAt: CHECKED_AT,
    descriptor: {
      environmentId: record.environmentId,
      label: record.label,
      platform: {
        os: environment.os ?? "linux",
        arch: environment.arch ?? "x64",
        ...(environment.machine === undefined ? {} : { machine: environment.machine }),
      },
      serverVersion: environment.serverVersion ?? "0.0.0-dev",
      capabilities: { repositoryIdentity: false },
    },
  };
}

const unavailable = (action: ManagedRelay.ManagedRelayRequestAction) => () =>
  Effect.fail(
    new ManagedRelay.ManagedRelayRequestFailedError({
      action,
      cause: new Error("Staged T3 Connect machines cannot be reached."),
    }),
  );

const answer =
  <A>(value: A) =>
  () =>
    Effect.succeed(value);

/** Answers account reads from the staged config; anything that would reach a machine fails. */
function makeDevFakeManagedRelayClient(config: DevFakeConnect) {
  const statuses = new Map(
    config.environments.map((environment) => [
      environment.environmentId,
      environmentStatus(environment),
    ]),
  );
  return ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.fake-connect.invalid",
    listEnvironments: answer(config.environments.map(environmentRecord)),
    listDevices: answer([]),
    createEnvironmentLinkChallenge: unavailable("create relay environment link challenge"),
    linkEnvironment: unavailable("link relay environment"),
    unlinkEnvironment: unavailable("unlink relay environment"),
    getT3ChatLink: answer({ available: false, link: null }),
    createT3ChatLinkRequest: unavailable("start T3 Chat linking"),
    unlinkT3Chat: unavailable("unlink T3 Chat account"),
    getEnvironmentStatus: Effect.fn("DevFakeConnect.getEnvironmentStatus")(function* (input: {
      readonly environmentId: string;
    }) {
      const status = statuses.get(input.environmentId);
      if (status === undefined) return yield* unavailable("get relay environment status")();
      return status;
    }),
    connectEnvironment: unavailable("connect relay environment"),
    registerDevice: unavailable("register relay mobile device"),
    unregisterDevice: unavailable("unregister relay mobile device"),
    registerLiveActivity: unavailable("register relay live activity"),
    getAgentActivitySnapshot: unavailable("read relay agent activity snapshot"),
    resetTokenCache: Effect.void,
  });
}

export const layerDevFakeManagedRelay = (config: DevFakeConnect) =>
  Layer.succeed(ManagedRelay.ManagedRelayClient, makeDevFakeManagedRelayClient(config));
