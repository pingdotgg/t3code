import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IssueTrackerKind } from "@t3tools/contracts";
import {
  isStandaloneIssueTracker,
  IssueTrackerError,
  type IssueTrackerApi,
  type StandaloneIssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as BuiltInIssueTrackers from "./builtInIssueTrackers.ts";
import * as IssueTrackerHostLive from "./IssueTrackerHostLive.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

const sharedHostLimits = new Set(
  ["gitlab", "azure-devops", "forgejo"].map((kind) => IssueTrackerKind.make(kind)),
);

function withRateLimitBackoff(
  api: IssueTrackerApi,
  limits: SourceControlRateLimit.SourceControlRateLimit["Service"],
): IssueTrackerApi {
  const wrap =
    <I extends { readonly host: string }, A>(
      operation: string,
      call: (input: I) => Effect.Effect<A, IssueTrackerError>,
      allowPaused = false,
    ) =>
    (input: I) => {
      const key = { provider: api.kind, host: input.host };
      return limits.check(key, allowPaused ? { allowPaused: true } : undefined).pipe(
        Effect.mapError(
          (cause) =>
            new IssueTrackerError({
              tracker: api.kind,
              operation,
              reason: "rate-limited",
              detail: cause.detail,
              retryAt: cause.retryAt,
              cause,
            }),
        ),
        Effect.flatMap((lease) =>
          Effect.suspend(() => call(input)).pipe(
            Effect.provideService(SourceControlRateLimit.Interactive, allowPaused),
            Effect.tap(() => limits.recordSuccess({ ...key, lease })),
            Effect.tapError((error) =>
              error.reason === "rate-limited"
                ? limits.recordRateLimit({
                    ...key,
                    lease,
                    ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
                  })
                : Effect.void,
            ),
          ),
        ),
      );
    };
  return {
    ...api,
    getViewer: wrap("getViewer", api.getViewer),
    listIssues: wrap("listIssues", api.listIssues),
    getIssue: wrap("getIssue", api.getIssue),
    getComments: wrap("getComments", api.getComments),
    getViewerPermissions: wrap("getViewerPermissions", api.getViewerPermissions, true),
    ...(api.create === undefined ? {} : { create: wrap("create", api.create, true) }),
    ...(api.comment === undefined ? {} : { comment: wrap("comment", api.comment, true) }),
    ...(api.update === undefined ? {} : { update: wrap("update", api.update, true) }),
    ...(api.setState === undefined ? {} : { setState: wrap("setState", api.setState, true) }),
    ...(api.setReaction === undefined
      ? {}
      : { setReaction: wrap("setReaction", api.setReaction, true) }),
    ...(api.listTemplates === undefined
      ? {}
      : { listTemplates: wrap("listTemplates", api.listTemplates) }),
    ...(api.listCandidates === undefined
      ? {}
      : { listCandidates: wrap("listCandidates", api.listCandidates) }),
  };
}

export class IssueTrackerRegistry extends Context.Service<
  IssueTrackerRegistry,
  {
    /** Null for a kind with no implementation, which the service reports as unsupported. */
    readonly get: (kind: IssueTrackerKind) => IssueTrackerApi | null;
    readonly kinds: ReadonlyArray<IssueTrackerKind>;
    /** The trackers a user connects with a credential of their own, in registration order. */
    readonly standalone: ReadonlyArray<StandaloneIssueTrackerApi>;
  }
>()("t3/issue/IssueTrackerRegistry") {}

/** Exported for tests, which stand a registry up from trackers they supply themselves. */
export function fromTrackers(
  trackers: ReadonlyArray<IssueTrackerApi>,
): IssueTrackerRegistry["Service"] {
  const byKind = new Map(trackers.map((tracker) => [tracker.kind, tracker]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: trackers.map((tracker) => tracker.kind),
    standalone: trackers.filter(isStandaloneIssueTracker),
  };
}

export const makeWithTrackers = Effect.fn(function* (trackers: ReadonlyArray<IssueTrackerApi>) {
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  return fromTrackers(
    trackers.map((api) =>
      sharedHostLimits.has(api.kind) && !isStandaloneIssueTracker(api)
        ? withRateLimitBackoff(api, limits)
        : api,
    ),
  );
});

const make = Effect.gen(function* () {
  const trackers = yield* Effect.forEach(
    BuiltInIssueTrackers.BUILT_IN_ISSUE_TRACKERS,
    (driver) => driver.make,
  );
  return yield* makeWithTrackers(trackers);
});

export const layer = Layer.effect(IssueTrackerRegistry, make).pipe(
  Layer.provide(Layer.merge(BuiltInDrivers.layer, IssueTrackerHostLive.layer)),
);
