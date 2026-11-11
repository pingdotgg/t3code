/**
 * Endpoint reconciliation shared by `AWS.Lambda.WebFunction` (its built-in
 * endpoint) and `AWS.Lambda.WebFunctionEndpoint` (additional endpoints).
 *
 * NOT exported from `index.ts`.
 */
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import { deepEqual } from "alchemy/Diff";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { AWSEnvironment } from "../Environment.ts";

export class WebFunctionNotReady extends Data.TaggedError("WebFunctionNotReady")<{
  functionName: string;
  resource: string;
  state?: string;
}> {
  override get message() {
    return `Lambda web function ${this.functionName}: ${this.resource} is ${this.state ?? "not ready"}`;
  }
}

export class WebFunctionFailed extends Data.TaggedError("WebFunctionFailed")<{
  functionName: string;
  resource: string;
  reason?: string;
}> {
  override get message() {
    return `Lambda web function ${this.functionName}: ${this.resource} failed: ${this.reason ?? "unknown reason"}`;
  }
}

export type WebFunctionAuthType = "ApplicationManaged" | "IamAuth";

/**
 * Send part of an endpoint's traffic to a new revision and keep the rest on
 * the revision it served before.
 */
export interface WebFunctionCanary {
  /**
   * Percent of traffic (0–100) for the revision this deploy publishes. `0`
   * rolls back: all traffic returns to the previous revision. `100`
   * promotes, the same as removing `canary`.
   */
  weight: number;
}

/** The settings of one endpoint, as declared on either resource. */
export interface WebFunctionEndpointSpec {
  endpointName: string;
  authType: WebFunctionAuthType;
  regions?: readonly string[];
  maxEnvironments?: number;
  rateLimit?: number;
  description?: string;
  canary?: WebFunctionCanary;
}

/** How an endpoint splits traffic between at most two revisions. */
export interface WebFunctionRevisionWeight {
  revisionId: string;
  weight: number;
}

/** A setting is outside the range Lambda accepts. */
export class WebFunctionInvalidConfig extends Data.TaggedError("WebFunctionInvalidConfig")<{
  resourceId: string;
  setting: string;
  message: string;
}> {}

/**
 * Check settings against Lambda's limits at plan time, so a bad value fails
 * before anything is created instead of mid-deploy.
 */
export const validateWebFunctionSettings = (
  resourceId: string,
  settings: {
    rateLimit?: number;
    maxEnvironments?: number;
    maxConcurrencyPerEnvironment?: number;
    timeoutSeconds?: number;
    canary?: WebFunctionCanary;
  },
): Effect.Effect<void, WebFunctionInvalidConfig> => {
  const invalid = (setting: string, message: string) =>
    Effect.fail(
      new WebFunctionInvalidConfig({
        resourceId,
        setting,
        message: `"${resourceId}": ${message}`,
      }),
    );
  const { rateLimit, maxEnvironments, maxConcurrencyPerEnvironment, timeoutSeconds, canary } =
    settings;
  if (
    canary !== undefined &&
    (!Number.isInteger(canary.weight) || canary.weight < 0 || canary.weight > 100)
  ) {
    return invalid(
      "canary",
      `canary weight ${canary.weight} is not allowed: use a whole number from 0 to 100.`,
    );
  }
  if (rateLimit !== undefined) {
    const step = rateLimit <= 1000 ? 100 : 1000;
    if (
      !Number.isInteger(rateLimit) ||
      rateLimit < 0 ||
      rateLimit > 10_000 ||
      rateLimit % step !== 0
    ) {
      const lower = Math.max(0, Math.floor(rateLimit / step) * step);
      const upper = Math.min(10_000, Math.ceil(rateLimit / step) * step);
      return invalid(
        "rateLimit",
        `rateLimit ${rateLimit} is not allowed: use 0–1,000 in steps of 100 or 1,000–10,000 in steps of 1,000 (e.g. ${lower} or ${upper}).`,
      );
    }
  }
  if (
    maxEnvironments !== undefined &&
    (!Number.isInteger(maxEnvironments) || maxEnvironments < 2 || maxEnvironments > 10_000)
  ) {
    return invalid(
      "maxEnvironments",
      `maxEnvironments ${maxEnvironments} is not allowed: use a whole number from 2 to 10,000.`,
    );
  }
  if (
    maxConcurrencyPerEnvironment !== undefined &&
    (!Number.isInteger(maxConcurrencyPerEnvironment) ||
      maxConcurrencyPerEnvironment < 1 ||
      maxConcurrencyPerEnvironment > 128)
  ) {
    return invalid(
      "maxConcurrencyPerEnvironment",
      `maxConcurrencyPerEnvironment ${maxConcurrencyPerEnvironment} is not allowed: use a whole number from 1 to 128.`,
    );
  }
  if (timeoutSeconds !== undefined && (timeoutSeconds < 3 || timeoutSeconds > 900)) {
    return invalid(
      "timeout",
      `timeout of ${timeoutSeconds} seconds is not allowed: use 3 seconds to 15 minutes.`,
    );
  }
  return Effect.void;
};

export type WebFunctionEndpointType = "HomeRegion" | "MultiRegion";

export const endpointTypeOf = (regions: readonly string[] | undefined): WebFunctionEndpointType =>
  regions !== undefined && regions.length > 0 ? "MultiRegion" : "HomeRegion";

export const normalizeRegions = (regions: readonly string[] | undefined) =>
  [...new Set(regions ?? [])].sort();

/** Endpoint type and Regions are immutable: changing them recreates the endpoint. */
export const endpointIdentityChanged = (
  olds: { regions?: readonly string[] },
  news: { regions?: readonly string[] },
) =>
  endpointTypeOf(olds.regions) !== endpointTypeOf(news.regions) ||
  !deepEqual(normalizeRegions(olds.regions), normalizeRegions(news.regions));

/**
 * Endpoint names allow letters, digits, `-` and `_`, up to 64 characters,
 * and can't begin or end with `-` or `_`.
 */
export const toEndpointName = (id: string) =>
  id
    .replaceAll(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);

/** The `endpointConfig` for `CreateWebFunction` (the built-in endpoint). */
export const createEndpointConfig = (spec: WebFunctionEndpointSpec): LambdaWeb.EndpointConfig => {
  const endpointType = endpointTypeOf(spec.regions);
  return {
    endpointName: spec.endpointName,
    description: spec.description,
    endpointType,
    ...(endpointType === "MultiRegion" ? { regions: normalizeRegions(spec.regions) } : {}),
    authType: spec.authType,
    autoDeploymentMode: "Disabled",
    ...(spec.maxEnvironments === undefined
      ? {}
      : { scalingConfig: { maxEnvironments: spec.maxEnvironments } }),
    ...(spec.rateLimit === undefined ? {} : { throttleConfig: { rateLimit: spec.rateLimit } }),
  };
};

export const getEndpoint = (functionName: string, endpointName: string) =>
  LambdaWeb.getWebFunctionEndpoint({ functionName, endpointName }).pipe(
    Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
  );

/**
 * The rate limit and environment cap an endpoint enforces, as observed.
 * Both endpoint resources report them so `alchemy drift` detects
 * out-of-band changes.
 */
export const endpointLimits = (endpoint: LambdaWeb.GetWebFunctionEndpointResponse) => ({
  rateLimit: endpoint.throttleConfig?.rateLimit,
  maxEnvironments: endpoint.scalingConfig?.maxEnvironments,
});

/** Revisions an endpoint sends traffic to. */
export const servedRevisions = (endpoint: {
  revisionWeights: readonly WebFunctionRevisionWeight[];
}) => endpoint.revisionWeights.filter((w) => w.weight > 0);

/**
 * The newest revision an endpoint serves: the canary while one runs,
 * otherwise the only revision. `published` (the revision the last deploy
 * published) decides when the endpoint serves two.
 */
export const latestRevisionId = (
  endpoint: { revisionWeights: readonly WebFunctionRevisionWeight[] },
  published?: string,
) => {
  const served = servedRevisions(endpoint);
  if (published !== undefined && served.some((w) => w.revisionId === published)) {
    return published;
  }
  return [...served].sort((a, b) => a.weight - b.weight)[0]?.revisionId ?? "";
};

/**
 * Split traffic between the revision this deploy publishes (`revisionId`)
 * and the stable one the endpoint serves now. The stable revision is the
 * served revision other than the one the previous deploy published, so a
 * second code change during a canary replaces the canary and keeps the
 * stable revision. Without `published` (adoption), the heavier one is
 * stable.
 */
const revisionWeightsFor = ({
  observed,
  revisionId,
  published,
  canary,
}: {
  observed: { revisionWeights: readonly WebFunctionRevisionWeight[] } | undefined;
  revisionId: string;
  published: string | undefined;
  canary: WebFunctionCanary | undefined;
}): WebFunctionRevisionWeight[] => {
  const all = [{ revisionId, weight: 100 }];
  if (canary === undefined || canary.weight >= 100 || observed === undefined) return all;
  const served = servedRevisions(observed);
  const stable =
    published === undefined
      ? [...served].sort((a, b) => b.weight - a.weight)[0]?.revisionId
      : (served.find((w) => w.revisionId !== published) ?? served[0])?.revisionId;
  // Nothing to compare against yet (first deploy), or the code is back on
  // the stable revision.
  if (stable === undefined || stable === revisionId) return all;
  if (canary.weight <= 0) return [{ revisionId: stable, weight: 100 }];
  return [
    { revisionId: stable, weight: 100 - canary.weight },
    { revisionId, weight: canary.weight },
  ];
};

const byRevision = (weights: readonly WebFunctionRevisionWeight[]) =>
  [...weights].sort((a, b) => a.revisionId.localeCompare(b.revisionId));

/** Settings `UpdateWebFunctionEndpoint` changes in place. */
const desiredSettings = (
  spec: WebFunctionEndpointSpec,
  revisionWeights: WebFunctionRevisionWeight[],
) => ({
  description: spec.description ?? "",
  authType: spec.authType,
  autoDeploymentMode: "Disabled" as const,
  revisionWeights,
  // `{}` clears a previously set value.
  scalingConfig:
    spec.maxEnvironments === undefined ? {} : { maxEnvironments: spec.maxEnvironments },
  throttleConfig: spec.rateLimit === undefined ? {} : { rateLimit: spec.rateLimit },
});

const settingsMatch = (
  observed: LambdaWeb.GetWebFunctionEndpointResponse,
  desired: ReturnType<typeof desiredSettings>,
) =>
  (observed.description ?? "") === desired.description &&
  observed.authType === desired.authType &&
  observed.autoDeploymentMode === desired.autoDeploymentMode &&
  deepEqual(byRevision(servedRevisions(observed)), byRevision(desired.revisionWeights)) &&
  observed.scalingConfig?.maxEnvironments === desired.scalingConfig.maxEnvironments &&
  observed.throttleConfig?.rateLimit === desired.throttleConfig.rateLimit;

/** Another update to the same function or endpoint is in progress. */
const retryConflict = <A, E extends { _tag: string }, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.retry({
      while: (e) => e._tag === "ConflictException",
      schedule: Schedule.spaced("2 seconds"),
      times: 15,
    }),
  );

const waitForSettled = (
  functionName: string,
  endpointName: string,
  session: { note: (note: string) => Effect.Effect<void> },
) =>
  Effect.gen(function* () {
    const endpoint = yield* getEndpoint(functionName, endpointName);
    if (endpoint?.state === "Failed" || endpoint?.updateStatus === "Failed") {
      return yield* new WebFunctionFailed({
        functionName,
        resource: `endpoint ${endpointName}`,
        reason: endpoint.updateStatusReason ?? endpoint.stateReason,
      });
    }
    if (endpoint?.state === "Active" && endpoint.updateStatus !== "InProgress") {
      return endpoint;
    }
    return yield* new WebFunctionNotReady({
      functionName,
      resource: `endpoint ${endpointName}`,
      state: endpoint?.updateStatus === "InProgress" ? "updating" : (endpoint?.state ?? "missing"),
    });
  }).pipe(
    Effect.tapError((e) =>
      e._tag === "WebFunctionNotReady" ? session.note(e.message) : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "WebFunctionNotReady",
      schedule: Schedule.spaced("2 seconds"),
      times: 90,
    }),
  );

/** Delete an endpoint and wait until it is gone. Idempotent. */
export const deleteEndpoint = (functionName: string, endpointName: string) =>
  Effect.gen(function* () {
    yield* LambdaWeb.deleteWebFunctionEndpoint({ functionName, endpointName }).pipe(
      retryConflict,
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
    yield* Effect.gen(function* () {
      const endpoint = yield* getEndpoint(functionName, endpointName);
      if (endpoint === undefined) return;
      return yield* new WebFunctionNotReady({
        functionName,
        resource: `endpoint ${endpointName}`,
        state: endpoint.state,
      });
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "WebFunctionNotReady",
        schedule: Schedule.spaced("2 seconds"),
        times: 45,
      }),
    );
  });

/**
 * Converge one endpoint on `spec`, routing traffic to `revisionId` (all of
 * it, or `spec.canary.weight` percent with the rest on the stable
 * revision): observe it, recreate it when its type or Regions disagree,
 * create it when missing, update the in-place settings that differ, and
 * wait until it settles. `published` is the revision the previous deploy
 * published to this endpoint.
 */
export const syncEndpoint = Effect.fn(function* ({
  functionName,
  spec,
  revisionId,
  published,
  session,
}: {
  functionName: string;
  spec: WebFunctionEndpointSpec;
  revisionId: string;
  published?: string;
  session: { note: (note: string) => Effect.Effect<void> };
}) {
  const endpointType = endpointTypeOf(spec.regions);
  // Lambda adds the home Region to a MultiRegion endpoint itself.
  const { region: homeRegion } = yield* AWSEnvironment.current;
  const remoteRegions = (regions: readonly string[] | undefined) =>
    normalizeRegions(regions?.filter((r) => r !== homeRegion));

  let endpoint = yield* getEndpoint(functionName, spec.endpointName);
  if (
    endpoint !== undefined &&
    (endpoint.endpointType !== endpointType ||
      (endpointType === "MultiRegion" &&
        !deepEqual(remoteRegions(endpoint.regions), remoteRegions(spec.regions))))
  ) {
    yield* deleteEndpoint(functionName, spec.endpointName);
    endpoint = undefined;
  }

  const settings = desiredSettings(
    spec,
    revisionWeightsFor({ observed: endpoint, revisionId, published, canary: spec.canary }),
  );
  if (endpoint === undefined) {
    yield* LambdaWeb.createWebFunctionEndpoint({
      functionName,
      ...createEndpointConfig(spec),
      revisionWeights: settings.revisionWeights,
    }).pipe(retryConflict);
  } else if (!settingsMatch(endpoint, settings)) {
    yield* LambdaWeb.updateWebFunctionEndpoint({
      functionName,
      endpointName: spec.endpointName,
      ...settings,
    }).pipe(retryConflict);
  }
  return yield* waitForSettled(functionName, spec.endpointName, session);
});
