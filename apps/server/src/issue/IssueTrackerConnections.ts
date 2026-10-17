/**
 * Standalone issue trackers (Linear, Jira) as the settings page manages them: credentials in
 * the secret store, with its status read live from the tracker, and the
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
import * as Crypto from "effect/Crypto";
import * as Semaphore from "effect/Semaphore";
import {
  IssueTrackerConnectionError,
  issueHostKey,
  IssueTrackerKind,
  type IssueTrackerBindProjectInput,
  type IssueTrackerConnectInput,
  type IssueTrackerConnection,
  type IssueTrackerConnectionList,
  type IssueTrackerProjectBinding,
  type IssueTrackerScopePage,
  type IssueTrackerScopesInput,
  type ProjectId,
} from "@t3tools/contracts";
import type { StandaloneIssueTrackerApi } from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as IssueTrackerAccounts from "../persistence/IssueTrackerAccounts.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { issueTrackerSecretName } from "./IssueTrackerHostLive.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const encoder = new TextEncoder();

export class IssueTrackerConnections extends Context.Service<
  IssueTrackerConnections,
  {
    /** Every standalone tracker, each probed against its stored credential, and the bindings. */
    readonly list: Effect.Effect<IssueTrackerConnectionList, IssueTrackerConnectionError>;
    readonly listScopes: (
      input: IssueTrackerScopesInput,
    ) => Effect.Effect<IssueTrackerScopePage, IssueTrackerConnectionError>;
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
  const accounts = yield* IssueTrackerAccounts.IssueTrackerAccountsRepository;
  const crypto = yield* Crypto.Crypto;
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

  const disconnected = (
    api: StandaloneIssueTrackerApi,
    connectionId?: string,
  ): IssueTrackerConnection => ({
    ...api.standalone,
    ...(connectionId === undefined ? {} : { connectionId }),
    connected: false,
    account: null,
    detail: null,
    scopes: [],
  });

  const rejected = (tracker: IssueTrackerKind, detail: string) =>
    new IssueTrackerConnectionError({ tracker, reason: "rejected", detail });
  const accountFor = (api: StandaloneIssueTrackerApi, connectionId: string) =>
    accounts.list.pipe(
      Effect.mapError(secretFailure(api.kind, "The saved accounts could not be read.")),
      Effect.flatMap((saved) => {
        const account = saved.find(
          (account) => account.tracker === api.kind && account.connectionId === connectionId,
        );
        return account === undefined
          ? Effect.fail(rejected(api.kind, "This account is no longer connected."))
          : Effect.succeed(account);
      }),
    );
  const probeCredential = (api: StandaloneIssueTrackerApi, token: string) =>
    api.probeCredential(token).pipe(
      Effect.mapError(
        (cause) =>
          new IssueTrackerConnectionError({
            tracker: api.kind,
            reason: cause.reason === "unauthenticated" ? "rejected" : "failed",
            detail: cause.detail,
            cause,
          }),
      ),
    );
  const status = (
    api: StandaloneIssueTrackerApi,
    token: string,
    saved?: Parameters<IssueTrackerAccounts.IssueTrackerAccountsRepository["Service"]["set"]>[0],
  ) =>
    api.probeCredential(token).pipe(
      Effect.map((probe): IssueTrackerConnection => {
        const host = issueHostKey(probe.host ?? api.standalone.host ?? "") || null;
        const matching =
          saved === undefined ||
          (issueHostKey(saved.host) === host && saved.accountId === probe.accountId);
        return {
          ...api.standalone,
          ...(saved === undefined ? {} : { connectionId: saved.connectionId }),
          host,
          connected: true,
          account: matching ? probe.account : null,
          detail: matching ? null : "The credential no longer belongs to this saved account.",
          scopes: matching ? probe.scopes : [],
          ...(matching && probe.scopesCursor !== undefined
            ? { scopesCursor: probe.scopesCursor }
            : {}),
          ...(probe.scopesTruncated === undefined
            ? {}
            : { scopesTruncated: probe.scopesTruncated }),
        };
      }),
      Effect.catch((error) =>
        Effect.succeed<IssueTrackerConnection>({
          ...api.standalone,
          ...(saved === undefined ? {} : { connectionId: saved.connectionId, host: saved.host }),
          connected: true,
          account: null,
          detail: error.detail,
          scopes: [],
        }),
      ),
    );
  const current = (
    api: StandaloneIssueTrackerApi,
    saved?: Parameters<IssueTrackerAccounts.IssueTrackerAccountsRepository["Service"]["set"]>[0],
  ) =>
    secrets.get(issueTrackerSecretName(api.kind, saved?.connectionId)).pipe(
      Effect.mapError(secretFailure(api.kind, "The stored credential could not be read.")),
      Effect.flatMap((stored) =>
        Option.isNone(stored)
          ? Effect.succeed(disconnected(api, saved?.connectionId))
          : status(api, new TextDecoder().decode(stored.value), saved),
      ),
    );

  const list: IssueTrackerConnections["Service"]["list"] = Effect.gen(function* () {
    const result = yield* Effect.all({
      trackers: Effect.forEach(registry.standalone, (api) => current(api), { concurrency: 4 }),
      bound: bindings.list.pipe(
        Effect.mapError(secretFailure(anyTracker, "The project bindings could not be read.")),
      ),
      accounts: accounts.list.pipe(
        Effect.mapError(secretFailure(anyTracker, "The saved accounts could not be read.")),
      ),
    });
    const extra = yield* Effect.forEach(
      result.accounts,
      (saved) => {
        const api = registry.standalone.find((api) => api.kind === saved.tracker);
        return api === undefined
          ? Effect.succeed([])
          : current(api, saved).pipe(Effect.map((account) => [account]));
      },
      { concurrency: 4 },
    );
    return {
      trackers: result.trackers,
      accounts: [...result.trackers.filter((account) => account.connected), ...extra.flat()],
      bindings: Object.fromEntries(
        Array.from(result.bound).flatMap(([projectId, bound]) =>
          bound[0] === undefined ? [] : [[projectId, bound[0]]],
        ),
      ),
      projectBindings: Object.fromEntries(result.bound),
    };
  });

  const listScopes: IssueTrackerConnections["Service"]["listScopes"] = (input) =>
    Effect.gen(function* () {
      const api = yield* requireTracker(input.tracker);
      if (api.listScopes === undefined)
        return yield* rejected(api.kind, "This tracker does not support browsing more scopes.");
      if (input.connectionId !== undefined) yield* accountFor(api, input.connectionId);
      const stored = yield* secrets
        .get(issueTrackerSecretName(api.kind, input.connectionId))
        .pipe(Effect.mapError(secretFailure(api.kind, "The stored credential could not be read.")));
      if (Option.isNone(stored))
        return yield* rejected(api.kind, "This account is no longer connected.");
      return yield* api
        .listScopes(new TextDecoder().decode(stored.value), {
          cursor: input.cursor,
          limit: input.limit ?? 100,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new IssueTrackerConnectionError({
                tracker: api.kind,
                reason: cause.reason === "unauthenticated" ? "rejected" : "failed",
                detail: cause.detail,
                cause,
              }),
          ),
        );
    });

  const saveCredential = (
    api: StandaloneIssueTrackerApi,
    token: string,
    stored: Option.Option<Uint8Array>,
    previousBindings: ReadonlyArray<readonly [ProjectId, IssueTrackerProjectBinding]>,
    preserveBindings: boolean,
    connectionId?: string,
  ) => {
    return Effect.gen(function* () {
      if (!preserveBindings) {
        yield* bindings
          .removeTracker(api.kind, connectionId)
          .pipe(
            Effect.mapError(
              secretFailure(api.kind, "The previous project bindings could not be cleared."),
            ),
          );
      }
      yield* secrets
        .set(issueTrackerSecretName(api.kind, connectionId), encoder.encode(token))
        .pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              const previous = Option.getOrNull(stored);
              const credentialMatchesPrevious = secrets
                .get(issueTrackerSecretName(api.kind, connectionId))
                .pipe(
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
                    ? secrets.remove(issueTrackerSecretName(api.kind, connectionId))
                    : secrets.set(issueTrackerSecretName(api.kind, connectionId), previous)
                ).pipe(
                  Effect.catch((cause) =>
                    credentialMatchesPrevious.pipe(
                      Effect.flatMap((restored) => (restored ? Effect.void : Effect.fail(cause))),
                    ),
                  ),
                  Effect.tapError(() => bindings.removeTracker(api.kind, connectionId)),
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
  };

  const connectAccount = (
    api: StandaloneIssueTrackerApi,
    input: IssueTrackerConnectInput,
    token: string | null,
  ) =>
    Effect.gen(function* () {
      if (input.addAccount && (input.connectionId !== undefined || token === null))
        return yield* rejected(api.kind, "Choose either Add account or an existing account.");
      const saved =
        input.connectionId === undefined ? undefined : yield* accountFor(api, input.connectionId);
      if (token === null) {
        if (saved === undefined)
          return yield* rejected(api.kind, "Choose the account to disconnect.");
        yield* secrets
          .remove(issueTrackerSecretName(api.kind, saved.connectionId))
          .pipe(Effect.mapError(secretFailure(api.kind, "The credential could not be removed.")));
        yield* bindings
          .removeTracker(api.kind, saved.connectionId)
          .pipe(
            Effect.mapError(secretFailure(api.kind, "The project bindings could not be cleared.")),
          );
        yield* accounts
          .remove(api.kind, saved.connectionId)
          .pipe(
            Effect.mapError(secretFailure(api.kind, "The saved account could not be removed.")),
          );
        return disconnected(api, saved.connectionId);
      }
      const probe = yield* probeCredential(api, token);
      const host = issueHostKey(probe.host ?? api.standalone.host ?? "");
      if (!host || !probe.accountId?.trim())
        return yield* rejected(
          api.kind,
          "The credential did not identify a tracker host and account.",
        );
      if (
        saved !== undefined &&
        (issueHostKey(saved.host) !== host || saved.accountId !== probe.accountId)
      )
        return yield* rejected(
          api.kind,
          "This credential belongs to a different account. Use Add account instead.",
        );
      if (saved === undefined) {
        const existing = yield* accounts.list.pipe(
          Effect.mapError(secretFailure(api.kind, "The saved accounts could not be read.")),
        );
        if (
          existing.some(
            (account) =>
              account.tracker === api.kind &&
              issueHostKey(account.host) === host &&
              account.accountId === probe.accountId,
          )
        )
          return yield* rejected(
            api.kind,
            "This account is already connected. Replace its token instead.",
          );
      }
      const connectionId =
        saved?.connectionId ??
        (yield* crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError(
              secretFailure(api.kind, "The account identifier could not be created."),
            ),
          ));
      const name = issueTrackerSecretName(api.kind, connectionId);
      if (saved === undefined) {
        yield* Effect.gen(function* () {
          yield* secrets
            .create(name, encoder.encode(token))
            .pipe(Effect.mapError(secretFailure(api.kind, "The credential could not be stored.")));
          yield* accounts
            .set({ tracker: api.kind, connectionId, host, accountId: probe.accountId! })
            .pipe(
              Effect.tapError(() => secrets.remove(name)),
              Effect.mapError(secretFailure(api.kind, "The saved account could not be stored.")),
            );
        }).pipe(Effect.uninterruptible);
      } else {
        const stored = yield* secrets
          .get(name)
          .pipe(
            Effect.mapError(secretFailure(api.kind, "The stored credential could not be read.")),
          );
        yield* saveCredential(api, token, stored, [], true, connectionId);
      }
      return {
        ...api.standalone,
        connectionId,
        host,
        connected: true,
        account: probe.account,
        detail: null,
        scopes: probe.scopes,
        ...(probe.scopesCursor === undefined ? {} : { scopesCursor: probe.scopesCursor }),
        ...(probe.scopesTruncated === undefined ? {} : { scopesTruncated: probe.scopesTruncated }),
      };
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

  const connect: IssueTrackerConnections["Service"]["connect"] = (request) =>
    Effect.gen(function* () {
      const wrapped = request.token !== null && typeof request.token === "object";
      const token = wrapped ? request.token.value : request.token;
      const input = { ...request, token };
      const api = yield* requireTracker(input.tracker);
      if ((input.addAccount || input.connectionId !== undefined) && !wrapped)
        return yield* rejected(
          api.kind,
          "Account actions require a compatible server and account value.",
        );
      if (input.addAccount || input.connectionId !== undefined)
        return yield* connectAccount(api, request, token);
      if (token === null) return yield* disconnect(api);
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
      const host = issueHostKey(probe.host ?? api.standalone.host ?? "");
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
        issueHostKey(previous.value.host ?? api.standalone.host ?? "") === host &&
        previous.value.accountId !== undefined &&
        previous.value.accountId === probe.accountId;
      const previousBindings = sameIdentity
        ? []
        : yield* bindings.list.pipe(
            Effect.map((saved) =>
              Array.from(saved).flatMap(([projectId, bound]) =>
                bound
                  .filter(
                    (binding) => binding.tracker === api.kind && binding.connectionId === undefined,
                  )
                  .map((binding) => [projectId, binding] as const),
              ),
            ),
            Effect.mapError(secretFailure(api.kind, "The project bindings could not be read.")),
          );
      yield* saveCredential(api, token, stored, previousBindings, sameIdentity);
      return {
        ...api.standalone,
        host,
        connected: true,
        account: probe.account,
        detail: null,
        scopes: probe.scopes,
        ...(probe.scopesCursor === undefined ? {} : { scopesCursor: probe.scopesCursor }),
        ...(probe.scopesTruncated === undefined ? {} : { scopesTruncated: probe.scopesTruncated }),
      };
    }).pipe(mutations.withPermits(1));

  const bindProject: IssueTrackerConnections["Service"]["bindProject"] = (request) =>
    Effect.gen(function* () {
      const wrapped = request.binding !== null && "value" in request.binding;
      const binding = wrapped ? request.binding.value : request.binding;
      const input = { ...request, binding };
      if (
        (input.tracker !== undefined ||
          input.connectionId !== undefined ||
          binding?.connectionId !== undefined) &&
        !wrapped
      )
        return yield* rejected(
          binding?.tracker ?? input.tracker ?? anyTracker,
          "Account binding actions require a compatible server and account value.",
        );
      const savedBindings =
        (yield* bindings.list.pipe(
          Effect.mapError(
            secretFailure(
              binding?.tracker ?? input.tracker ?? anyTracker,
              "The project bindings could not be read.",
            ),
          ),
        )).get(input.projectId) ?? [];
      if (input.binding === null) {
        if (input.tracker === undefined && savedBindings.length > 1)
          return yield* rejected(anyTracker, "Choose the tracker to unbind.");
        const selected =
          input.tracker === undefined
            ? savedBindings[0]
            : savedBindings.find((binding) => binding.tracker === input.tracker);
        if (selected?.connectionId !== input.connectionId)
          return yield* rejected(
            input.tracker ?? anyTracker,
            "The project's selected account changed. Refresh its binding first.",
          );
        if (selected === undefined) return;
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* bindings
          .set({
            projectId: input.projectId,
            binding: null,
            tracker: selected.tracker,
            updatedAt,
          })
          .pipe(
            Effect.mapError(
              secretFailure(input.tracker ?? anyTracker, "The project binding could not be saved."),
            ),
          );
        return;
      }
      if (input.tracker !== undefined && input.tracker !== input.binding.tracker)
        return yield* rejected(input.tracker, "The binding does not match the selected tracker.");
      const previous = savedBindings.find((binding) => binding.tracker === input.binding?.tracker);
      if (
        input.binding.connectionId === undefined &&
        previous?.connectionId !== undefined &&
        previous.connectionId !== input.connectionId
      )
        return yield* rejected(
          input.binding.tracker,
          "The project's selected account changed. Refresh its binding first.",
        );
      const api = yield* requireTracker(input.binding.tracker);
      const tracker = api.kind;
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
      const savedAccount =
        input.binding.connectionId === undefined
          ? undefined
          : yield* accountFor(api, input.binding.connectionId);
      const stored = yield* secrets
        .get(issueTrackerSecretName(tracker, input.binding.connectionId))
        .pipe(Effect.mapError(secretFailure(tracker, "The stored credential could not be read.")));
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
      if (
        savedAccount !== undefined &&
        (issueHostKey(probe.host ?? api.standalone.host ?? "") !==
          issueHostKey(savedAccount.host) ||
          probe.accountId !== savedAccount.accountId)
      )
        return yield* rejected(tracker, "The credential no longer belongs to this saved account.");
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
      const host = issueHostKey(probe.host ?? api.standalone.host ?? "");
      if (!host) {
        return yield* new IssueTrackerConnectionError({
          tracker,
          reason: "rejected",
          detail: "The tracker host could not be verified.",
        });
      }
      const verifiedBinding = { ...input.binding, scope: scope.key, host };
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* bindings
        .set({ projectId: input.projectId, binding: verifiedBinding, updatedAt })
        .pipe(Effect.mapError(secretFailure(tracker, "The project binding could not be saved.")));
    }).pipe(mutations.withPermits(1));

  return IssueTrackerConnections.of({ list, listScopes, connect, bindProject });
});

export const layer = Layer.effect(IssueTrackerConnections, make);
