import {
  ProviderDriverKind,
  TrimmedNonEmptyString,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import bundledCompatibilityDocumentJson from "../../../../provider-compatibility.v1.json" with { type: "json" };
import packageJson from "../../package.json" with { type: "json" };
import {
  makeTargetedProviderUpdateAction,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";

const T3_CODE_VERSION = packageJson.version;
const REMOTE_COMPATIBILITY_CACHE_TTL = Duration.minutes(15);
const REMOTE_COMPATIBILITY_TIMEOUT = "2500 millis";
const REMOTE_COMPATIBILITY_CACHE_CAPACITY = 8;

export const DEFAULT_PROVIDER_COMPATIBILITY_MAP_URL =
  "https://t3.codes/provider-compatibility.v1.json";
export const GITHUB_PROVIDER_COMPATIBILITY_MAP_URL =
  "https://raw.githubusercontent.com/pingdotgg/t3code/main/provider-compatibility.v1.json";
export const DEFAULT_PROVIDER_COMPATIBILITY_MAP_URLS = [
  DEFAULT_PROVIDER_COMPATIBILITY_MAP_URL,
  GITHUB_PROVIDER_COMPATIBILITY_MAP_URL,
] as const;

const RemoteCompatibilityRange = Schema.Struct({
  status: Schema.Literals(["unknown", "supported", "graceful", "unsupported", "broken"]),
  range: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
});

const RemoteCompatibilityPolicy = Schema.Struct({
  t3CodeRange: TrimmedNonEmptyString,
  driver: TrimmedNonEmptyString,
  recommendedRange: Schema.NullOr(TrimmedNonEmptyString),
  recommendedVersion: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  ranges: Schema.Array(RemoteCompatibilityRange),
});

const RemoteCompatibilityDocument = Schema.Struct({
  version: Schema.Literal(1),
  policies: Schema.Array(RemoteCompatibilityPolicy),
});

export type ProviderCompatibilityDocument = typeof RemoteCompatibilityDocument.Type;

type ProviderCompatibilitySnapshot = Pick<ServerProvider, "enabled" | "status" | "message"> & {
  readonly compatibilityAdvisory?: ServerProviderCompatibilityAdvisory | undefined;
};

const decodeCompatibilityDocument = Schema.decodeUnknownEffect(RemoteCompatibilityDocument);

/**
 * Repo-root compatibility JSON bundled into the app. Used when the remote map
 * cannot be fetched or has no matching policy for the current provider/build.
 */
const bundledProviderCompatibilityDocument = Schema.decodeUnknownSync(RemoteCompatibilityDocument)(
  bundledCompatibilityDocumentJson,
);

function remoteCompatibilityMapUrls(): ReadonlyArray<string> {
  const configured = process.env.T3_PROVIDER_COMPATIBILITY_MAP_URL?.trim();
  if (!configured) {
    return DEFAULT_PROVIDER_COMPATIBILITY_MAP_URLS;
  }
  const urls = configured
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return urls.length > 0 ? urls : DEFAULT_PROVIDER_COMPATIBILITY_MAP_URLS;
}

function policyMatches(input: {
  readonly policy: typeof RemoteCompatibilityPolicy.Type;
  readonly driver: ProviderDriverKind;
  readonly t3CodeVersion: string;
}): boolean {
  return (
    input.policy.driver === input.driver &&
    satisfiesSemverRange(input.t3CodeVersion, input.policy.t3CodeRange)
  );
}

function compatibilityPolicyForDriver(input: {
  readonly document: typeof RemoteCompatibilityDocument.Type;
  readonly driver: ProviderDriverKind;
  readonly t3CodeVersion?: string;
}): typeof RemoteCompatibilityPolicy.Type | null {
  const t3CodeVersion = input.t3CodeVersion ?? T3_CODE_VERSION;
  return (
    input.document.policies.find((policy) =>
      policyMatches({ policy, driver: input.driver, t3CodeVersion }),
    ) ?? null
  );
}

function severityForStatus(
  status: ServerProviderCompatibilityAdvisory["status"],
): ServerProviderCompatibilityAdvisory["severity"] {
  switch (status) {
    case "broken":
      return "error";
    case "unsupported":
    case "graceful":
      return "warning";
    case "supported":
    case "unknown":
      return "info";
  }
}

function messageForStatus(input: {
  readonly status: ServerProviderCompatibilityAdvisory["status"];
  readonly currentVersion: string | null;
  readonly recommendedRange: string | null;
  readonly recommendedVersion: string | null;
}) {
  const current = input.currentVersion ? ` ${input.currentVersion}` : "";
  const recommendedTarget = input.recommendedVersion ?? input.recommendedRange;
  const recommended = recommendedTarget ? ` Use ${recommendedTarget}.` : "";
  switch (input.status) {
    case "broken":
      return `This provider harness version${current} is known to be incompatible with this T3 Code release.${recommended}`;
    case "unsupported":
      return `This provider harness version${current} is outside the compatibility range for this T3 Code release.${recommended}`;
    case "graceful":
      return `This provider harness version${current} should still work, but updating is recommended.${recommended}`;
    case "unknown":
      return `T3 Code could not determine whether this provider harness version is compatible.${recommended}`;
    case "supported":
      return null;
  }
}

function createProviderCompatibilityAdvisoryFromDocument(input: {
  readonly document: typeof RemoteCompatibilityDocument.Type;
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities | undefined;
  readonly t3CodeVersion?: string;
}): ServerProviderCompatibilityAdvisory | undefined {
  const policy = compatibilityPolicyForDriver({
    document: input.document,
    driver: input.driver,
    ...(input.t3CodeVersion ? { t3CodeVersion: input.t3CodeVersion } : {}),
  });
  if (!policy) {
    return undefined;
  }

  const currentVersion = input.currentVersion;
  const matchedRange =
    currentVersion === null
      ? undefined
      : policy.ranges.find((range) => satisfiesSemverRange(currentVersion, range.range));
  const status = matchedRange?.status ?? (currentVersion === null ? "unknown" : "unsupported");
  const recommendedVersion = policy.recommendedVersion ?? null;
  const targetedUpdateAction = input.maintenanceCapabilities
    ? makeTargetedProviderUpdateAction(input.maintenanceCapabilities, recommendedVersion)
    : null;

  return {
    status,
    severity: severityForStatus(status),
    currentVersion: input.currentVersion,
    message: messageForStatus({
      status,
      currentVersion: input.currentVersion,
      recommendedRange: policy.recommendedRange,
      recommendedVersion,
    }),
    recommendedRange: policy.recommendedRange,
    recommendedVersion,
    updateCommand: targetedUpdateAction?.command ?? null,
    canUpdate: targetedUpdateAction !== null,
    ranges: [...policy.ranges],
  };
}

function shouldSkipCompatibilityAdvisory(input: {
  readonly snapshot: ProviderCompatibilitySnapshot;
  readonly currentVersion: string | null;
}): boolean {
  return !input.snapshot.enabled && input.currentVersion === null;
}

export function createProviderCompatibilityAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly document?: typeof RemoteCompatibilityDocument.Type;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities | undefined;
  readonly t3CodeVersion?: string;
}): ServerProviderCompatibilityAdvisory | undefined {
  return createProviderCompatibilityAdvisoryFromDocument({
    document: input.document ?? bundledProviderCompatibilityDocument,
    driver: input.driver,
    currentVersion: input.currentVersion,
    maintenanceCapabilities: input.maintenanceCapabilities,
    ...(input.t3CodeVersion ? { t3CodeVersion: input.t3CodeVersion } : {}),
  });
}

const fetchRemoteCompatibilityDocument = Effect.fn("fetchRemoteCompatibilityDocument")(
  function* (url: string) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("user-agent", `t3code/${T3_CODE_VERSION}`),
        ),
      )
      .pipe(Effect.timeoutOption(REMOTE_COMPATIBILITY_TIMEOUT));

    if (Option.isNone(response)) {
      return null;
    }

    const httpResponse = response.value;
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return null;
    }

    const payload = yield* httpResponse.json.pipe(
      Effect.flatMap(decodeCompatibilityDocument),
      Effect.catch(() => Effect.succeed(null)),
    );
    return payload;
  },
  (effect, url) =>
    effect.pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("provider compatibility map fetch failed", {
          cause,
          url,
        }),
      ),
      Effect.catch(() => Effect.succeed(null)),
    ),
);

function applyCompatibilityAdvisory<Snapshot extends ProviderCompatibilitySnapshot>(
  snapshot: Snapshot,
  compatibilityAdvisory: ServerProviderCompatibilityAdvisory | undefined,
): Snapshot {
  const baseSnapshot = removeExistingCompatibilityAdvisory(snapshot);
  if (!compatibilityAdvisory) {
    return baseSnapshot;
  }

  const status =
    baseSnapshot.enabled && compatibilityAdvisory.severity === "error"
      ? "error"
      : baseSnapshot.enabled &&
          compatibilityAdvisory.severity === "warning" &&
          baseSnapshot.status === "ready"
        ? "warning"
        : baseSnapshot.status;
  const compatibilityMessage =
    status !== baseSnapshot.status && compatibilityAdvisory.severity !== "info"
      ? (compatibilityAdvisory.message ?? undefined)
      : undefined;
  const advisoryWithPreState: ServerProviderCompatibilityAdvisory = {
    ...compatibilityAdvisory,
    preAdvisoryStatus: baseSnapshot.status,
    ...(baseSnapshot.message ? { preAdvisoryMessage: baseSnapshot.message } : {}),
  };

  return {
    ...baseSnapshot,
    status,
    ...(compatibilityMessage || baseSnapshot.message
      ? { message: compatibilityMessage ?? baseSnapshot.message }
      : {}),
    compatibilityAdvisory: advisoryWithPreState,
  } as Snapshot;
}

function removeExistingCompatibilityAdvisory<Snapshot extends ProviderCompatibilitySnapshot>(
  snapshot: Snapshot,
): Snapshot {
  if (!snapshot.compatibilityAdvisory) {
    return snapshot;
  }

  const { compatibilityAdvisory: existingCompatibilityAdvisory, ...baseSnapshot } = snapshot;
  const compatibilityMessage =
    existingCompatibilityAdvisory.severity !== "info"
      ? (existingCompatibilityAdvisory.message ?? undefined)
      : undefined;
  if (compatibilityMessage && baseSnapshot.message === compatibilityMessage) {
    const { message: _message, ...snapshotWithoutCompatibilityMessage } = baseSnapshot;
    const restoredStatus =
      existingCompatibilityAdvisory.preAdvisoryStatus ?? (snapshot.enabled ? "ready" : "disabled");
    return {
      ...snapshotWithoutCompatibilityMessage,
      status: restoredStatus,
      ...(existingCompatibilityAdvisory.preAdvisoryMessage
        ? { message: existingCompatibilityAdvisory.preAdvisoryMessage }
        : {}),
    } as Snapshot;
  }
  if (existingCompatibilityAdvisory.preAdvisoryStatus !== undefined) {
    return {
      ...baseSnapshot,
      status: existingCompatibilityAdvisory.preAdvisoryStatus,
    } as Snapshot;
  }
  return baseSnapshot as Snapshot;
}

export function applyBundledProviderCompatibilityAdvisory<
  Snapshot extends ProviderCompatibilitySnapshot,
>(input: {
  readonly snapshot: Snapshot;
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities | undefined;
}): Snapshot {
  if (
    shouldSkipCompatibilityAdvisory({
      snapshot: input.snapshot,
      currentVersion: input.currentVersion,
    })
  ) {
    return removeExistingCompatibilityAdvisory(input.snapshot);
  }

  return applyCompatibilityAdvisory(
    input.snapshot,
    createProviderCompatibilityAdvisory({
      driver: input.driver,
      currentVersion: input.currentVersion,
      maintenanceCapabilities: input.maintenanceCapabilities,
    }),
  );
}

export const enrichProviderSnapshotWithCompatibilityAdvisory = Effect.fn(
  "enrichProviderSnapshotWithCompatibilityAdvisory",
)(function* (snapshot: ServerProvider) {
  const compatibility = yield* ProviderCompatibilityService;
  return yield* compatibility.enrichSnapshot(snapshot);
});

export const enrichProviderSnapshotWithTargetedCompatibilityAdvisory = Effect.fn(
  "enrichProviderSnapshotWithTargetedCompatibilityAdvisory",
)(function* (snapshot: ServerProvider, maintenanceCapabilities: ProviderMaintenanceCapabilities) {
  const compatibility = yield* ProviderCompatibilityService;
  return yield* compatibility.enrichSnapshot(snapshot, maintenanceCapabilities);
});

export interface ProviderCompatibilityServiceShape {
  readonly resolveRemoteDocument: Effect.Effect<typeof RemoteCompatibilityDocument.Type | null>;
  readonly enrichSnapshot: (
    snapshot: ServerProvider,
    maintenanceCapabilities?: ProviderMaintenanceCapabilities | undefined,
  ) => Effect.Effect<ServerProvider>;
}

export class ProviderCompatibilityService extends Context.Service<
  ProviderCompatibilityService,
  ProviderCompatibilityServiceShape
>()("t3/provider/ProviderCompatibilityService") {}

export const makeProviderCompatibilityService = Effect.fn("makeProviderCompatibilityService")(
  function* () {
    const remoteDocumentCache = yield* Cache.makeWith(fetchRemoteCompatibilityDocument, {
      capacity: REMOTE_COMPATIBILITY_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null
          ? REMOTE_COMPATIBILITY_CACHE_TTL
          : Duration.zero,
    });

    const resolveRemoteDocument = Effect.gen(function* () {
      for (const url of remoteCompatibilityMapUrls()) {
        const document = yield* Cache.get(remoteDocumentCache, url);
        if (document) {
          return document;
        }
      }

      return null;
    });

    return {
      resolveRemoteDocument,
      enrichSnapshot: (snapshot, maintenanceCapabilities) =>
        resolveRemoteDocument.pipe(
          Effect.map((remoteDocument) =>
            shouldSkipCompatibilityAdvisory({
              snapshot,
              currentVersion: snapshot.version,
            })
              ? removeExistingCompatibilityAdvisory(snapshot)
              : applyCompatibilityAdvisory(
                  snapshot,
                  createProviderCompatibilityAdvisory({
                    driver: snapshot.driver,
                    currentVersion: snapshot.version,
                    maintenanceCapabilities,
                    ...(remoteDocument ? { document: remoteDocument } : {}),
                  }),
                ),
          ),
        ),
    } satisfies ProviderCompatibilityServiceShape;
  },
);

export const layer = Layer.effect(ProviderCompatibilityService, makeProviderCompatibilityService());
