import type {
  IssueTrackerProjectBinding,
  IssueTrackerBindInput,
  ProjectId,
} from "@t3tools/contracts";
import { IssueTrackingError } from "@t3tools/contracts";
import type { IssueTracker } from "./IssueProvider.ts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearApi from "./LinearApi.ts";

const coordinatorMutex = Semaphore.makeUnsafe(1);

export function clearCredentialBindings(
  bindings: Readonly<Record<string, IssueTrackerProjectBinding | null>>,
  credentialId: string,
): Record<string, null> {
  return Object.fromEntries(
    Object.entries(bindings).flatMap(([projectId, binding]) =>
      binding?.credentialId === credentialId ? [[projectId, null]] : [],
    ),
  );
}

export const linearConnectionStatus = Effect.gen(function* () {
  const linear = yield* LinearApi.LinearApi;
  return yield* linear.connection;
});

export const connectLinearAccount = (token: string) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      return yield* linear.connect(token);
    }),
  );

export const setLinearProjectBinding = (input: Omit<IssueTrackerBindInput, "provider">) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const connection = yield* linear.connection;
      const binding = input.binding;
      if (binding !== null && binding.credentialId !== undefined) {
        const account = connection.accounts.find(
          ({ credentialId }) => credentialId === binding.credentialId,
        );
        if (account === undefined) {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            credentialId: binding.credentialId,
            teamKey: binding.repository,
            bindingRejection: "unknown-credential",
          });
        }
        if (account.status !== "authenticated") {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            credentialId: binding.credentialId,
            teamKey: binding.repository,
            bindingRejection: "account-unavailable",
          });
        }
        if (!account.projects.some(({ key }) => key === binding.repository)) {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            credentialId: binding.credentialId,
            teamKey: binding.repository,
            bindingRejection: "team-unavailable",
          });
        }
      } else if (binding !== null) {
        const environmentAccount = connection.environmentAccount;
        if (
          environmentAccount?.status !== "authenticated" ||
          !environmentAccount.projects.some(({ key }) => key === binding.repository)
        ) {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            teamKey: binding.repository,
            bindingRejection: "environment-account-unavailable",
          });
        }
      }

      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        issueTracking: {
          connections: { linear: { projectBindings: { [input.projectId]: binding } } },
        },
      });
    }),
  );

export const disconnectLinearAccount = (input: { readonly credentialId: string }) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const { credentialId } = input;

      const settings = yield* ServerSettings.ServerSettingsService;
      const current = yield* settings.getSettings;

      const removals = clearCredentialBindings(
        current.issueTracking.connections.linear?.projectBindings ?? {},
        credentialId,
      );
      const restorations = Object.fromEntries(
        Object.keys(removals).flatMap((projectId) => {
          const binding =
            current.issueTracking.connections.linear?.projectBindings[projectId as ProjectId];
          return binding === undefined ? [] : [[projectId, binding]];
        }),
      );
      if (Object.keys(removals).length > 0) {
        yield* settings.updateSettings({
          issueTracking: {
            connections: {
              linear: { projectBindings: removals },
            },
          },
        });
      }
      return yield* linear.disconnect({ credentialId }).pipe(
        Effect.tapError(() =>
          Object.keys(restorations).length === 0
            ? Effect.void
            : settings.updateSettings({
                issueTracking: { connections: { linear: { projectBindings: restorations } } },
              }),
        ),
      );
    }),
  );

export const make = Effect.gen(function* () {
  const context = yield* Effect.context<
    LinearApi.LinearApi | ServerSettings.ServerSettingsService
  >();
  const wrap = <
    A,
    E extends { readonly message: string },
    R extends LinearApi.LinearApi | ServerSettings.ServerSettingsService,
  >(
    operation: IssueTrackingError["operation"],
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.provideContext(context),
      Effect.mapError(
        (cause) => new IssueTrackingError({ operation, detail: cause.message, cause }),
      ),
    );
  return {
    status: wrap("status", linearConnectionStatus),
    connect: (token) => wrap("connect", connectLinearAccount(token)),
    disconnect: (credentialId) => wrap("disconnect", disconnectLinearAccount({ credentialId })),
    bind: (input) => wrap("bind", setLinearProjectBinding(input)),
  } satisfies IssueTracker;
});
