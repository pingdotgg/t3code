/**
 * Standalone issue trackers (Linear, Jira) as the settings page manages them: one credential per
 * tracker kind in the secret store, with its status read live from the tracker, and the
 * per-project binding that puts a tracker's scope beside the project's git-host issues.
 * Disconnecting clears the bindings that pointed at the tracker.
 *
 * Nothing here knows which trackers exist: the registry lists them and each driver's descriptor
 * says what to call the credential and the scope. Adding a tracker adds no code here.
 *
 * @module issue/IssueTrackerConnections
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Semaphore from "effect/Semaphore";
import {
  IssueTrackerConnectionError,
  IssueTrackerKind,
  type IssueTrackerBindProjectInput,
  type IssueTrackerConnectInput,
  type IssueTrackerConnection,
  type IssueTrackerConnectionList,
} from "@t3tools/contracts";
import type { StandaloneIssueTrackerApi } from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { issueTrackerSecretName } from "./IssueTrackerHostLive.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const encoder = new TextEncoder();

export class IssueTrackerConnections extends Context.Service<
  IssueTrackerConnections,
  {
    /** Every standalone tracker, each probed against its stored credential, and the bindings. */
    readonly list: Effect.Effect<IssueTrackerConnectionList, IssueTrackerConnectionError>;
    /**
     * Vets the credential with the tracker and stores it only when the tracker accepts it. A null
     * token removes the stored one and unbinds every project that pointed at the tracker.
     */
    readonly connect: (
      input: IssueTrackerConnectInput,
    ) => Effect.Effect<IssueTrackerConnection, IssueTrackerConnectionError>;
    /** Binds a project to one of a tracker's scopes, or unbinds it with a null binding. */
    readonly bindProject: (
      input: IssueTrackerBindProjectInput,
    ) => Effect.Effect<void, IssueTrackerConnectionError>;
  }
>()("t3/issue/IssueTrackerConnections") {}

const make = Effect.gen(function* () {
  const registry = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository;
  const projects = yield* ProjectService.ProjectService;
  const mutations = yield* Semaphore.make(1);

  const requireTracker = (
    tracker: IssueTrackerKind,
  ): Effect.Effect<StandaloneIssueTrackerApi, IssueTrackerConnectionError> => {
    const found = registry.standalone.find((api) => api.kind === tracker);
    return found === undefined
      ? Effect.fail(
          new IssueTrackerConnectionError({
            tracker,
            reason: "unknown-tracker",
            detail: "This server has no such issue tracker.",
          }),
        )
      : Effect.succeed(found);
  };

  /** The kind an error about no tracker in particular is filed under. */
  const anyTracker = registry.standalone[0]?.kind ?? IssueTrackerKind.make("none");

  const secretFailure = (tracker: IssueTrackerKind, detail: string) => (cause: unknown) =>
    new IssueTrackerConnectionError({ tracker, reason: "failed", detail, cause });

  const disconnected = (api: StandaloneIssueTrackerApi): IssueTrackerConnection => ({
    ...api.standalone,
    connected: false,
    account: null,
    detail: null,
    scopes: [],
  });

  /** The tracker's view of a stored credential; a refusal is status, not a failure. */
  const status = (api: StandaloneIssueTrackerApi, token: string) =>
    api.probeCredential(token).pipe(
      Effect.map((probe): IssueTrackerConnection => ({
        ...api.standalone,
        host: (probe.host ?? api.standalone.host)?.trim().toLowerCase() ?? null,
        connected: true,
        account: probe.account,
        detail: null,
        scopes: probe.scopes,
        ...(probe.scopesTruncated === undefined ? {} : { scopesTruncated: probe.scopesTruncated }),
      })),
      Effect.catch((error) =>
        Effect.succeed<IssueTrackerConnection>({
          ...api.standalone,
          connected: true,
          account: null,
          detail: error.detail,
          scopes: [],
        }),
      ),
    );

  const current = (api: StandaloneIssueTrackerApi) =>
    secrets.get(issueTrackerSecretName(api.kind)).pipe(
      Effect.mapError(secretFailure(api.kind, "The stored credential could not be read.")),
      Effect.flatMap((stored) =>
        Option.isNone(stored)
          ? Effect.succeed(disconnected(api))
          : status(api, new TextDecoder().decode(stored.value)),
      ),
    );

  const list: IssueTrackerConnections["Service"]["list"] = Effect.all({
    trackers: Effect.forEach(registry.standalone, current, { concurrency: 4 }),
    bindings: bindings.list.pipe(
      Effect.map((bound) => Object.fromEntries(bound)),
      // No single tracker is at fault; the first registered one carries the report.
      Effect.mapError(secretFailure(anyTracker, "The project bindings could not be read.")),
    ),
  });

  const disconnect = (api: StandaloneIssueTrackerApi) =>
    Effect.gen(function* () {
      yield* secrets
        .remove(issueTrackerSecretName(api.kind))
        .pipe(Effect.mapError(secretFailure(api.kind, "The credential could not be removed.")));
      // Bindings to a tracker nobody is signed into would only produce errors in every listing.
      yield* bindings
        .removeTracker(api.kind)
        .pipe(
          Effect.mapError(secretFailure(api.kind, "The project bindings could not be cleared.")),
        );
      return disconnected(api);
    });

  const connect: IssueTrackerConnections["Service"]["connect"] = (input) =>
    Effect.gen(function* () {
      const api = yield* requireTracker(input.tracker);
      if (input.token === null) return yield* disconnect(api);
      const token = input.token;
      const probe = yield* api.probeCredential(token).pipe(
        Effect.mapError(
          (error) =>
            new IssueTrackerConnectionError({
              tracker: input.tracker,
              reason: error.reason === "unauthenticated" ? "rejected" : "failed",
              detail: error.detail,
              cause: error,
            }),
        ),
      );
      const host = (probe.host ?? api.standalone.host)?.trim().toLowerCase();
      if (!host) {
        return yield* new IssueTrackerConnectionError({
          tracker: input.tracker,
          reason: "rejected",
          detail: "The credential did not identify a tracker host.",
        });
      }
      const stored = yield* secrets
        .get(issueTrackerSecretName(api.kind))
        .pipe(Effect.mapError(secretFailure(api.kind, "The stored credential could not be read.")));
      const previous = Option.isNone(stored)
        ? Option.none()
        : yield* api.probeCredential(new TextDecoder().decode(stored.value)).pipe(Effect.option);
      const sameIdentity =
        Option.isSome(previous) &&
        (previous.value.host ?? api.standalone.host)?.trim().toLowerCase() === host &&
        previous.value.accountId !== undefined &&
        previous.value.accountId === probe.accountId;
      const previousBindings = sameIdentity
        ? []
        : yield* bindings.list.pipe(
            Effect.map((saved) =>
              Array.from(saved).filter(([, binding]) => binding.tracker === api.kind),
            ),
            Effect.mapError(secretFailure(api.kind, "The project bindings could not be read.")),
          );
      yield* Effect.gen(function* () {
        if (!sameIdentity) {
          yield* bindings
            .removeTracker(api.kind)
            .pipe(
              Effect.mapError(
                secretFailure(api.kind, "The previous project bindings could not be cleared."),
              ),
            );
        }
        yield* secrets.set(issueTrackerSecretName(api.kind), encoder.encode(token)).pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              const previous = Option.getOrNull(stored);
              const credentialMatchesPrevious = secrets.get(issueTrackerSecretName(api.kind)).pipe(
                Effect.map((current) =>
                  previous === null
                    ? Option.isNone(current)
                    : Option.isSome(current) && Buffer.from(previous).equals(current.value),
                ),
                Effect.orElseSucceed(() => false),
              );
              if (!(yield* credentialMatchesPrevious)) {
                yield* (
                  previous === null
                    ? secrets.remove(issueTrackerSecretName(api.kind))
                    : secrets.set(issueTrackerSecretName(api.kind), previous)
                ).pipe(
                  Effect.catch((cause) =>
                    credentialMatchesPrevious.pipe(
                      Effect.flatMap((restored) => (restored ? Effect.void : Effect.fail(cause))),
                    ),
                  ),
                  Effect.tapError(() => bindings.removeTracker(api.kind)),
                );
              }
              const updatedAt = DateTime.formatIso(yield* DateTime.now);
              yield* Effect.forEach(
                previousBindings,
                ([projectId, binding]) => bindings.set({ projectId, binding, updatedAt }),
                { discard: true },
              );
            }),
          ),
          Effect.mapError(secretFailure(api.kind, "The credential could not be stored.")),
        );
      }).pipe(Effect.uninterruptible);
      return {
        ...api.standalone,
        host,
        connected: true,
        account: probe.account,
        detail: null,
        scopes: probe.scopes,
        ...(probe.scopesTruncated === undefined ? {} : { scopesTruncated: probe.scopesTruncated }),
      };
    }).pipe(mutations.withPermits(1));

  const bindProject: IssueTrackerConnections["Service"]["bindProject"] = (input) =>
    Effect.gen(function* () {
      // Unbinding names no tracker; the first registered one carries any report.
      let tracker = anyTracker;
      let verifiedBinding = input.binding;
      if (input.binding !== null) {
        const api = yield* requireTracker(input.binding.tracker);
        tracker = api.kind;
        const project = yield* projects
          .getById(input.projectId)
          .pipe(Effect.mapError(secretFailure(tracker, "The project could not be read.")));
        if (Option.isNone(project)) {
          return yield* new IssueTrackerConnectionError({
            tracker,
            reason: "rejected",
            detail: "This project is no longer available.",
          });
        }
        const stored = yield* secrets
          .get(issueTrackerSecretName(tracker))
          .pipe(
            Effect.mapError(secretFailure(tracker, "The stored credential could not be read.")),
          );
        const token = Option.isSome(stored) ? new TextDecoder().decode(stored.value) : "";
        if (token.trim().length === 0) {
          return yield* new IssueTrackerConnectionError({
            tracker,
            reason: "rejected",
            detail: "Connect this tracker before binding a project.",
          });
        }
        const probe = yield* api.probeCredential(token).pipe(
          Effect.mapError(
            (cause) =>
              new IssueTrackerConnectionError({
                tracker,
                reason: cause.reason === "unauthenticated" ? "rejected" : "failed",
                detail: "The stored credential could not be verified.",
                cause,
              }),
          ),
        );
        let scope = probe.scopes.find((scope) => scope.key === input.binding?.scope);
        if (scope === undefined && probe.scopesTruncated && api.getScope !== undefined) {
          scope =
            (yield* api.getScope(token, input.binding.scope).pipe(
              Effect.mapError(
                (cause) =>
                  new IssueTrackerConnectionError({
                    tracker,
                    reason: cause.reason === "unauthenticated" ? "rejected" : "failed",
                    detail: "The requested scope could not be verified.",
                    cause,
                  }),
              ),
            )) ?? undefined;
        }
        if (scope === undefined) {
          return yield* new IssueTrackerConnectionError({
            tracker,
            reason: "rejected",
            detail: "This scope is not available to the connected account.",
          });
        }
        const host = (probe.host ?? api.standalone.host)?.trim().toLowerCase();
        if (!host) {
          return yield* new IssueTrackerConnectionError({
            tracker,
            reason: "rejected",
            detail: "The tracker host could not be verified.",
          });
        }
        verifiedBinding = { ...input.binding, scope: scope.key, host };
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* bindings
        .set({ projectId: input.projectId, binding: verifiedBinding, updatedAt })
        .pipe(Effect.mapError(secretFailure(tracker, "The project binding could not be saved.")));
    }).pipe(mutations.withPermits(1));

  return IssueTrackerConnections.of({ list, connect, bindProject });
});

export const layer = Layer.effect(IssueTrackerConnections, make);
