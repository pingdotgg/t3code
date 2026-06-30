import {
  AuthConnectSecurityMode,
  type AuthClientMetadata,
  type AuthClientPresentationMetadata,
  type AuthConnectClient,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as AuthConnectClients from "../persistence/AuthConnectClients.ts";
import type { AuthConnectClientRepositoryError } from "../persistence/Errors.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const CONNECT_SECURITY_MODE_SECRET = "connect-security-mode";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const connectClientInternalErrorContext = {
  cause: Schema.Defect(),
};

export class ConnectSecurityModeLoadError extends Schema.TaggedErrorClass<ConnectSecurityModeLoadError>()(
  "ConnectSecurityModeLoadError",
  {
    ...connectClientInternalErrorContext,
    cause: Schema.optional(Schema.Defect()),
    invalidValue: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    if (this.invalidValue !== undefined) {
      return `Invalid Connect security mode: ${this.invalidValue}`;
    }
    return "Failed to load Connect security mode.";
  }
}

export class ConnectSecurityModeUpdateError extends Schema.TaggedErrorClass<ConnectSecurityModeUpdateError>()(
  "ConnectSecurityModeUpdateError",
  {
    ...connectClientInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to update Connect security mode.";
  }
}

export class ConnectClientsLoadError extends Schema.TaggedErrorClass<ConnectClientsLoadError>()(
  "ConnectClientsLoadError",
  {
    ...connectClientInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to load Connect clients.";
  }
}

export class ConnectClientRequestError extends Schema.TaggedErrorClass<ConnectClientRequestError>()(
  "ConnectClientRequestError",
  {
    clientProofKeyThumbprint: Schema.String,
    ...connectClientInternalErrorContext,
  },
) {
  override get message(): string {
    return `Failed to record Connect client '${this.clientProofKeyThumbprint}'.`;
  }
}

export class ConnectClientApprovalError extends Schema.TaggedErrorClass<ConnectClientApprovalError>()(
  "ConnectClientApprovalError",
  {
    clientProofKeyThumbprint: Schema.String,
    ...connectClientInternalErrorContext,
  },
) {
  override get message(): string {
    return `Failed to approve Connect client '${this.clientProofKeyThumbprint}'.`;
  }
}

export class ConnectClientRejectionError extends Schema.TaggedErrorClass<ConnectClientRejectionError>()(
  "ConnectClientRejectionError",
  {
    clientProofKeyThumbprint: Schema.String,
    ...connectClientInternalErrorContext,
  },
) {
  override get message(): string {
    return `Failed to reject Connect client '${this.clientProofKeyThumbprint}'.`;
  }
}

export class ConnectClientRevocationError extends Schema.TaggedErrorClass<ConnectClientRevocationError>()(
  "ConnectClientRevocationError",
  {
    clientProofKeyThumbprint: Schema.String,
    ...connectClientInternalErrorContext,
  },
) {
  override get message(): string {
    return `Failed to revoke Connect client '${this.clientProofKeyThumbprint}'.`;
  }
}

export const ConnectClientStoreError = Schema.Union([
  ConnectSecurityModeLoadError,
  ConnectSecurityModeUpdateError,
  ConnectClientsLoadError,
  ConnectClientRequestError,
  ConnectClientApprovalError,
  ConnectClientRejectionError,
  ConnectClientRevocationError,
]);
export type ConnectClientStoreError = typeof ConnectClientStoreError.Type;
export const isConnectClientStoreError = Schema.is(ConnectClientStoreError);

export type ConnectClientChange =
  | {
      readonly type: "connectSecurityModeUpdated";
      readonly mode: AuthConnectSecurityMode;
    }
  | {
      readonly type: "connectClientUpserted";
      readonly client: AuthConnectClient;
    }
  | {
      readonly type: "connectClientRemoved";
      readonly clientProofKeyThumbprint: string;
    };

export type ConnectClientAuthorization =
  | {
      readonly mode: "account";
      readonly status: "approved";
    }
  | {
      readonly mode: "client-approval";
      readonly status: "pending" | "approved" | "rejected";
      readonly client: AuthConnectClient;
    };

export class ConnectClientStore extends Context.Service<
  ConnectClientStore,
  {
    readonly getSecurityMode: () => Effect.Effect<
      AuthConnectSecurityMode,
      ConnectSecurityModeLoadError
    >;
    readonly setSecurityMode: (
      mode: AuthConnectSecurityMode,
    ) => Effect.Effect<AuthConnectSecurityMode, ConnectSecurityModeUpdateError>;
    readonly listClients: () => Effect.Effect<
      ReadonlyArray<AuthConnectClient>,
      ConnectClientsLoadError
    >;
    readonly requestClient: (input: {
      readonly cloudUserId: string;
      readonly clientProofKeyThumbprint: string;
      readonly deviceId?: string;
      readonly client?: AuthClientPresentationMetadata;
    }) => Effect.Effect<
      ConnectClientAuthorization,
      ConnectClientRequestError | ConnectSecurityModeLoadError
    >;
    readonly approve: (
      clientProofKeyThumbprint: string,
    ) => Effect.Effect<Option.Option<AuthConnectClient>, ConnectClientApprovalError>;
    readonly reject: (
      clientProofKeyThumbprint: string,
    ) => Effect.Effect<Option.Option<AuthConnectClient>, ConnectClientRejectionError>;
    readonly revoke: (
      clientProofKeyThumbprint: string,
    ) => Effect.Effect<boolean, ConnectClientRevocationError>;
    readonly streamChanges: Stream.Stream<ConnectClientChange>;
  }
>()("t3/auth/ConnectClientStore") {}

function toAuthClientMetadata(
  record: AuthConnectClients.AuthConnectClientMetadataRecord,
): AuthClientMetadata {
  return {
    ...(record.label ? { label: record.label } : {}),
    ...(record.ipAddress ? { ipAddress: record.ipAddress } : {}),
    ...(record.userAgent ? { userAgent: record.userAgent } : {}),
    deviceType: record.deviceType,
    ...(record.os ? { os: record.os } : {}),
    ...(record.browser ? { browser: record.browser } : {}),
  };
}

function toAuthConnectClient(
  record: AuthConnectClients.AuthConnectClientRecord,
): AuthConnectClient {
  return {
    clientProofKeyThumbprint: record.clientProofKeyThumbprint,
    cloudUserId: record.cloudUserId,
    ...(record.deviceId ? { deviceId: record.deviceId } : {}),
    status: record.status,
    client: toAuthClientMetadata(record.client),
    requestedAt: DateTime.toUtc(record.requestedAt),
    updatedAt: DateTime.toUtc(record.updatedAt),
    approvedAt: record.approvedAt === null ? null : DateTime.toUtc(record.approvedAt),
    rejectedAt: record.rejectedAt === null ? null : DateTime.toUtc(record.rejectedAt),
    lastSeenAt: record.lastSeenAt === null ? null : DateTime.toUtc(record.lastSeenAt),
  };
}

function fromPresentationMetadata(
  client: AuthClientPresentationMetadata | undefined,
): AuthConnectClients.AuthConnectClientMetadataRecord {
  return {
    label: client?.label ?? null,
    ipAddress: null,
    userAgent: null,
    deviceType: client?.deviceType ?? "unknown",
    os: client?.os ?? null,
    browser: null,
  };
}

function decodeSecurityMode(
  bytes: Uint8Array,
): Effect.Effect<AuthConnectSecurityMode, ConnectSecurityModeLoadError> {
  const value = textDecoder.decode(bytes).trim();
  if (value === "account" || value === "client-approval") {
    return Effect.succeed(value);
  }
  return Effect.fail(
    new ConnectSecurityModeLoadError({
      invalidValue: value,
    }),
  );
}

function encodeSecurityMode(mode: AuthConnectSecurityMode): Uint8Array {
  return textEncoder.encode(mode);
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const repository = yield* AuthConnectClients.AuthConnectClientRepository;
  const changesPubSub = yield* PubSub.unbounded<ConnectClientChange>();

  const emitMode = (mode: AuthConnectSecurityMode) =>
    PubSub.publish(changesPubSub, {
      type: "connectSecurityModeUpdated",
      mode,
    }).pipe(Effect.asVoid);

  const emitUpsert = (client: AuthConnectClient) =>
    PubSub.publish(changesPubSub, {
      type: "connectClientUpserted",
      client,
    }).pipe(Effect.asVoid);

  const emitRemoved = (clientProofKeyThumbprint: string) =>
    PubSub.publish(changesPubSub, {
      type: "connectClientRemoved",
      clientProofKeyThumbprint,
    }).pipe(Effect.asVoid);

  const getSecurityMode: ConnectClientStore["Service"]["getSecurityMode"] = () =>
    secrets.get(CONNECT_SECURITY_MODE_SECRET).pipe(
      Effect.mapError((cause) => new ConnectSecurityModeLoadError({ cause })),
      Effect.flatMap((mode) =>
        Option.isSome(mode) ? decodeSecurityMode(mode.value) : Effect.succeed("account" as const),
      ),
      Effect.withSpan("ConnectClientStore.getSecurityMode"),
    );

  const setSecurityMode: ConnectClientStore["Service"]["setSecurityMode"] = (mode) =>
    secrets.set(CONNECT_SECURITY_MODE_SECRET, encodeSecurityMode(mode)).pipe(
      Effect.as(mode),
      Effect.tap(emitMode),
      Effect.mapError((cause) => new ConnectSecurityModeUpdateError({ cause })),
      Effect.withSpan("ConnectClientStore.setSecurityMode"),
    );

  const listClients: ConnectClientStore["Service"]["listClients"] = () =>
    repository.listActive().pipe(
      Effect.map((clients) => clients.map(toAuthConnectClient)),
      Effect.mapError((cause) => new ConnectClientsLoadError({ cause })),
      Effect.withSpan("ConnectClientStore.listClients"),
    );

  const requestClient: ConnectClientStore["Service"]["requestClient"] = Effect.fn(
    "ConnectClientStore.requestClient",
  )(function* (input) {
    const mode = yield* getSecurityMode();
    if (mode === "account") {
      return { mode, status: "approved" as const };
    }

    const upsertClientRequest = (requestedAt: DateTime.Utc) =>
      repository
        .upsertRequest({
          clientProofKeyThumbprint: input.clientProofKeyThumbprint,
          cloudUserId: input.cloudUserId,
          deviceId: input.deviceId ?? null,
          client: fromPresentationMetadata(input.client),
          requestedAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ConnectClientRequestError({
                clientProofKeyThumbprint: input.clientProofKeyThumbprint,
                cause,
              }),
          ),
        );
    const requestedAt = yield* DateTime.now;
    const record = yield* upsertClientRequest(requestedAt);

    const visibleClient = toAuthConnectClient(record);
    yield* emitUpsert(visibleClient);

    if (record.status !== "approved") {
      return { mode, status: record.status, client: visibleClient };
    }

    const seenAt = yield* DateTime.now;
    const seen = yield* repository
      .markSeen({
        clientProofKeyThumbprint: input.clientProofKeyThumbprint,
        seenAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ConnectClientRequestError({
              clientProofKeyThumbprint: input.clientProofKeyThumbprint,
              cause,
            }),
        ),
      );
    if (Option.isSome(seen)) {
      const seenClient = toAuthConnectClient(seen.value);
      yield* emitUpsert(seenClient);
      return { mode, status: seen.value.status, client: seenClient };
    }

    const reregisteredAt = yield* DateTime.now;
    const reregistered = yield* upsertClientRequest(reregisteredAt);
    const reregisteredClient = toAuthConnectClient(reregistered);
    yield* emitUpsert(reregisteredClient);
    return { mode, status: reregistered.status, client: reregisteredClient };
  });

  const updateDecision = <E extends ConnectClientApprovalError | ConnectClientRejectionError>(
    clientProofKeyThumbprint: string,
    status: "approved" | "rejected",
    toError: (cause: AuthConnectClientRepositoryError) => E,
  ): Effect.Effect<Option.Option<AuthConnectClient>, E> =>
    DateTime.now.pipe(
      Effect.flatMap((decidedAt) =>
        repository.updateStatus({
          clientProofKeyThumbprint,
          status,
          decidedAt,
        }),
      ),
      Effect.mapError(toError),
      Effect.map((updated) => Option.map(updated, toAuthConnectClient)),
      Effect.tap((updated) => (Option.isSome(updated) ? emitUpsert(updated.value) : Effect.void)),
    );

  const approve: ConnectClientStore["Service"]["approve"] = (clientProofKeyThumbprint) =>
    updateDecision(
      clientProofKeyThumbprint,
      "approved",
      (cause) =>
        new ConnectClientApprovalError({
          clientProofKeyThumbprint,
          cause,
        }),
    ).pipe(Effect.withSpan("ConnectClientStore.approve"));

  const reject: ConnectClientStore["Service"]["reject"] = (clientProofKeyThumbprint) =>
    updateDecision(
      clientProofKeyThumbprint,
      "rejected",
      (cause) =>
        new ConnectClientRejectionError({
          clientProofKeyThumbprint,
          cause,
        }),
    ).pipe(Effect.withSpan("ConnectClientStore.reject"));

  const revoke: ConnectClientStore["Service"]["revoke"] = (clientProofKeyThumbprint) =>
    DateTime.now.pipe(
      Effect.flatMap((revokedAt) =>
        repository.revoke({
          clientProofKeyThumbprint,
          revokedAt,
        }),
      ),
      Effect.tap((revoked) => (revoked ? emitRemoved(clientProofKeyThumbprint) : Effect.void)),
      Effect.mapError(
        (cause) =>
          new ConnectClientRevocationError({
            clientProofKeyThumbprint,
            cause,
          }),
      ),
      Effect.withSpan("ConnectClientStore.revoke"),
    );

  return ConnectClientStore.of({
    getSecurityMode,
    setSecurityMode,
    listClients,
    requestClient,
    approve,
    reject,
    revoke,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  });
});

export const layer = Layer.effect(ConnectClientStore, make).pipe(
  Layer.provideMerge(AuthConnectClients.layer),
);
