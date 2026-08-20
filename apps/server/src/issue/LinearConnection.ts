import type {
  LinearConnectInput,
  LinearConnection,
  LinearDisconnectInput,
  LinearProjectBinding,
  LinearSetProjectBindingInput,
  ProjectId,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearApi from "./LinearApi.ts";

const coordinatorMutex = Semaphore.makeUnsafe(1);

export function clearCredentialBindings(
  bindings: Readonly<Record<string, LinearProjectBinding | null>>,
  credentialId: string,
): Record<string, null> {
  return Object.fromEntries(
    Object.entries(bindings).flatMap(([projectId, binding]) =>
      binding?.credentialId === credentialId ? [[projectId, null]] : [],
    ),
  );
}

const syncLegacyBindings = (connection: LinearApi.LinearConnectionResult) =>
  Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings;
    if (linear.environmentTokenConfigured && connection.migratedCredentialId === undefined) {
      const environmentAccount = connection.environmentAccount;
      if (environmentAccount?.status !== "authenticated") return connection;
      const availableTeams = new Set(environmentAccount.teams.map(({ key }) => key));
      const projectBindingsToDelete = Object.entries(
        current.issueTracking.linear.projectTeams,
      ).flatMap(([projectId, teamKey]) =>
        current.issueTracking.linear.projectBindings[projectId as ProjectId] === null &&
        availableTeams.has(teamKey)
          ? [projectId as ProjectId]
          : [],
      );
      if (projectBindingsToDelete.length > 0) {
        yield* settings.updateSettings({
          issueTracking: { linear: { projectBindingsToDelete } },
        });
      }
      return connection;
    }
    const account =
      connection.migratedCredentialId === undefined
        ? connection.accounts.length === 1
          ? connection.accounts[0]
          : undefined
        : connection.accounts.find(
            ({ credentialId }) => credentialId === connection.migratedCredentialId,
          );
    if (account === undefined) return connection;

    const availableTeams = new Set(account.teams.map(({ key }) => key));
    const additions = Object.fromEntries(
      Object.entries(current.issueTracking.linear.projectTeams).flatMap(([projectId, teamKey]) => {
        const binding = current.issueTracking.linear.projectBindings[projectId as ProjectId];
        return binding == null &&
          (binding === undefined ||
            connection.migratedCredentialId !== undefined ||
            availableTeams.has(teamKey))
          ? [[projectId, { credentialId: account.credentialId, teamKey }]]
          : [];
      }),
    );
    if (Object.keys(additions).length > 0) {
      yield* settings.updateSettings({
        issueTracking: { linear: { projectBindings: additions } },
      });
    }
    if (connection.migratedCredentialId !== undefined) {
      yield* linear.completeLegacyMigration;
    }
    return connection;
  });

export const updateLegacyLinearProjectTeams = (patch: ServerSettingsPatch) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linearPatch = patch.issueTracking?.linear;
      const settings = yield* ServerSettings.ServerSettingsService;
      if (linearPatch?.projectTeams === undefined) return yield* settings.updateSettings(patch);

      const linear = yield* LinearApi.LinearApi;
      const connection = yield* linear.connection.pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath: "<linear-credentials>",
              operation: "read-secret",
              cause,
            }),
        ),
      );
      yield* syncLegacyBindings(connection).pipe(
        Effect.catchTags({ LinearApiError: () => Effect.void }),
      );

      const current = yield* settings.getSettings;
      const authenticatedAccounts =
        connection?.accounts.filter(({ status }) => status === "authenticated") ?? [];
      const migratedAccount = authenticatedAccounts.find(
        ({ credentialId }) => credentialId === connection?.migratedCredentialId,
      );
      const soleAccount =
        migratedAccount ??
        (authenticatedAccounts.length === 1 ? authenticatedAccounts[0] : undefined);
      const environmentAccount =
        connection?.migratedCredentialId === undefined &&
        connection?.environmentAccount?.status === "authenticated"
          ? connection.environmentAccount
          : undefined;
      const resolvedBindings: Record<string, LinearProjectBinding | null> = {};
      const projectBindingsToDelete = new Set(linearPatch.projectBindingsToDelete ?? []);

      for (const [projectId, teamKey] of Object.entries(linearPatch.projectTeams)) {
        const id = projectId as ProjectId;
        const existing = current.issueTracking.linear.projectBindings[id];
        const existingAccount =
          existing === null || existing === undefined
            ? undefined
            : connection.accounts.find(
                ({ credentialId }) => credentialId === existing.credentialId,
              );
        if (
          existing !== null &&
          existing !== undefined &&
          existing.teamKey === teamKey &&
          existingAccount?.status !== "authenticated"
        ) {
          resolvedBindings[projectId] = existing;
        } else if (existingAccount?.teams.some(({ key }) => key === teamKey)) {
          resolvedBindings[projectId] = {
            credentialId: existingAccount.credentialId,
            teamKey,
          };
        } else if (environmentAccount?.teams.some(({ key }) => key === teamKey)) {
          projectBindingsToDelete.add(id);
        } else if (soleAccount?.teams.some(({ key }) => key === teamKey)) {
          resolvedBindings[projectId] = { credentialId: soleAccount.credentialId, teamKey };
        } else {
          resolvedBindings[projectId] = null;
        }
      }

      return yield* settings.updateSettings({
        ...patch,
        issueTracking: {
          ...patch.issueTracking,
          linear: {
            ...linearPatch,
            projectBindings: { ...linearPatch.projectBindings, ...resolvedBindings },
            projectBindingsToDelete: [...projectBindingsToDelete],
          },
        },
      });
    }),
  );

export const linearConnectionStatus = coordinatorMutex.withPermits(1)(
  Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    return yield* syncLegacyBindings(yield* linear.connection);
  }),
);

export const connectLinearAccount = (token: string, mode?: LinearConnectInput["mode"]) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const previous = yield* linear.connection;
      yield* syncLegacyBindings(previous);
      const connected = yield* linear.connect(token);
      if (mode === "add") return yield* syncLegacyBindings(connected);

      const previousCredentialIds = new Set(
        previous.accounts.map(({ credentialId }) => credentialId),
      );
      const addedAccounts = connected.accounts.filter(
        ({ credentialId }) => !previousCredentialIds.has(credentialId),
      );
      const replacement =
        connected.accounts.find(
          ({ credentialId }) => credentialId === connected.connectedCredentialId,
        ) ??
        (addedAccounts.length === 1
          ? addedAccounts[0]
          : connected.accounts.length === 1
            ? connected.accounts[0]
            : undefined);
      if (replacement === undefined) {
        return yield* new LinearApi.LinearApiError({
          operation: "connect",
          reason: "failed",
        });
      }

      const settings = yield* ServerSettings.ServerSettingsService;
      const current = yield* settings.getSettings;
      const replacementTeamKeys = new Set(replacement.teams.map(({ key }) => key));
      const affectedBindings = Object.entries(current.issueTracking.linear.projectBindings).filter(
        ([, binding]) =>
          binding !== null &&
          previousCredentialIds.has(binding.credentialId) &&
          binding.credentialId !== replacement.credentialId,
      );
      const remappings = Object.fromEntries(
        affectedBindings.map(([projectId, binding]) => [
          projectId,
          binding !== null && replacementTeamKeys.has(binding.teamKey)
            ? { credentialId: replacement.credentialId, teamKey: binding.teamKey }
            : null,
        ]),
      );
      const unavailableProjectIds = affectedBindings.flatMap(([projectId, binding]) =>
        binding !== null && !replacementTeamKeys.has(binding.teamKey)
          ? [projectId as ProjectId]
          : [],
      );
      if (affectedBindings.length > 0) {
        yield* settings.updateSettings({
          issueTracking: {
            linear: {
              projectBindings: remappings,
              projectTeamsToDelete: unavailableProjectIds,
            },
          },
        });
      }

      let remainingConnection: LinearConnection = connected;
      const oldCredentialIds = [...previousCredentialIds].filter(
        (credentialId) => credentialId !== replacement.credentialId,
      );
      for (const [index, credentialId] of oldCredentialIds.entries()) {
        remainingConnection = yield* linear.disconnect({ credentialId }).pipe(
          Effect.tapError(() => {
            const remainingIds = new Set(oldCredentialIds.slice(index));
            const restorations = Object.fromEntries(
              Object.entries(current.issueTracking.linear.projectBindings).flatMap(
                ([projectId, binding]) =>
                  binding !== null &&
                  remainingIds.has(binding.credentialId) &&
                  !replacementTeamKeys.has(binding.teamKey)
                    ? [[projectId, binding]]
                    : [],
              ),
            );
            const projectTeams = Object.fromEntries(
              Object.keys(restorations).flatMap((projectId) => {
                const teamKey = current.issueTracking.linear.projectTeams[projectId as ProjectId];
                return teamKey === undefined ? [] : [[projectId, teamKey]];
              }),
            );
            return Object.keys(restorations).length === 0
              ? Effect.void
              : settings.updateSettings({
                  issueTracking: { linear: { projectBindings: restorations, projectTeams } },
                });
          }),
        );
      }
      return yield* syncLegacyBindings(remainingConnection);
    }),
  );

export const setLinearProjectBinding = (input: LinearSetProjectBindingInput) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const connection = yield* linear.connection;
      const binding = input.binding;
      if (binding !== null && "credentialId" in binding) {
        const account = connection.accounts.find(
          ({ credentialId }) => credentialId === binding.credentialId,
        );
        if (account === undefined) {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            credentialId: binding.credentialId,
            teamKey: binding.teamKey,
            bindingRejection: "unknown-credential",
          });
        }
        if (account.status !== "authenticated") {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            credentialId: binding.credentialId,
            teamKey: binding.teamKey,
            bindingRejection: "account-unavailable",
          });
        }
        if (!account.teams.some(({ key }) => key === binding.teamKey)) {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            credentialId: binding.credentialId,
            teamKey: binding.teamKey,
            bindingRejection: "team-unavailable",
          });
        }
      } else if (binding !== null) {
        const environmentAccount = connection.environmentAccount;
        if (
          environmentAccount?.status !== "authenticated" ||
          !environmentAccount.teams.some(({ key }) => key === binding.teamKey)
        ) {
          return yield* new LinearApi.LinearApiError({
            operation: "setProjectBinding",
            reason: "failed",
            projectId: input.projectId,
            teamKey: binding.teamKey,
            bindingRejection: "environment-account-unavailable",
          });
        }
      }

      const settings = yield* ServerSettings.ServerSettingsService;
      const linearPatch =
        binding === null
          ? {
              projectBindings: { [input.projectId]: null },
              projectTeamsToDelete: [input.projectId],
            }
          : "credentialId" in binding
            ? {
                projectBindings: { [input.projectId]: binding },
                projectTeamsToDelete: [input.projectId],
              }
            : {
                projectBindingsToDelete: [input.projectId],
                projectTeams: { [input.projectId]: binding.teamKey },
              };
      yield* settings.updateSettings({
        issueTracking: { linear: linearPatch },
      });
    }),
  );

export const disconnectLinearAccount = (input: LinearDisconnectInput) =>
  coordinatorMutex.withPermits(1)(
    Effect.gen(function* () {
      const linear = yield* LinearApi.LinearApi;
      const connection = yield* linear.connection;
      yield* syncLegacyBindings(connection);
      const disconnectLegacy =
        input === undefined && connection.accounts.length === 0 && connection.hasStoredToken;
      const credentialId =
        input?.credentialId ??
        (connection.accounts.length === 1 ? connection.accounts[0]?.credentialId : undefined);

      const settings = yield* ServerSettings.ServerSettingsService;
      const current = yield* settings.getSettings;
      if (disconnectLegacy) {
        const removals = Object.fromEntries(
          Object.keys(current.issueTracking.linear.projectTeams).map((projectId) => [
            projectId,
            null,
          ]),
        );
        const removalProjectIds = Object.keys(removals).map((projectId) => projectId as ProjectId);
        const restorations = Object.fromEntries(
          removalProjectIds.flatMap((projectId) => {
            const binding = current.issueTracking.linear.projectBindings[projectId];
            return binding === undefined ? [] : [[projectId, binding]];
          }),
        );
        const projectBindingsToDelete = removalProjectIds.filter(
          (projectId) => current.issueTracking.linear.projectBindings[projectId] === undefined,
        );
        if (Object.keys(removals).length > 0) {
          yield* settings.updateSettings({
            issueTracking: {
              linear: { projectBindings: removals, projectTeamsToDelete: removalProjectIds },
            },
          });
        }
        return yield* linear.disconnect(undefined).pipe(
          Effect.tapError(() =>
            settings.updateSettings({
              issueTracking: {
                linear: {
                  projectBindings: restorations,
                  projectBindingsToDelete,
                  projectTeams: current.issueTracking.linear.projectTeams,
                },
              },
            }),
          ),
        );
      }
      if (credentialId === undefined) {
        return yield* new LinearApi.LinearAccountSelectionRequiredError();
      }

      const removals = clearCredentialBindings(
        current.issueTracking.linear.projectBindings,
        credentialId,
      );
      const restorations = Object.fromEntries(
        Object.keys(removals).flatMap((projectId) => {
          const binding = current.issueTracking.linear.projectBindings[projectId as ProjectId];
          return binding === undefined ? [] : [[projectId, binding]];
        }),
      );
      const removalProjectIds = Object.keys(removals).map((projectId) => projectId as ProjectId);
      const projectTeams = Object.fromEntries(
        removalProjectIds.flatMap((projectId) => {
          const teamKey = current.issueTracking.linear.projectTeams[projectId];
          return teamKey === undefined ? [] : [[projectId, teamKey]];
        }),
      );
      if (Object.keys(removals).length > 0) {
        yield* settings.updateSettings({
          issueTracking: {
            linear: { projectBindings: removals, projectTeamsToDelete: removalProjectIds },
          },
        });
      }
      return yield* linear.disconnect({ credentialId }).pipe(
        Effect.tapError(() =>
          Object.keys(restorations).length === 0
            ? Effect.void
            : settings.updateSettings({
                issueTracking: { linear: { projectBindings: restorations, projectTeams } },
              }),
        ),
      );
    }),
  );
