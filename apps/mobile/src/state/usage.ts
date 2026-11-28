import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  AuthDiagnosticsReadScope,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageAccessRequest,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { refreshUsage, usageSummaryInput } from "@t3tools/client-runtime/state/usage";
import {
  resolveUsageAccess,
  unansweredUsageAccessRequests,
} from "@t3tools/client-runtime/state/usage-access";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg, useMessages } from "gt-react-native";
import { useCallback, useMemo } from "react";

import { keepMarked } from "../i18n/messages";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "./session";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly isConnected: boolean;
  readonly canReadDiagnostics: boolean;
  /** Agents still waiting for a usage access answer that this session may save. */
  readonly accessRequests: readonly UsageAccessRequest[];
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const access = resolveUsageAccess(
        {
          connectionPhase: presentation.connection.phase,
          session: AsyncResult.getOrElse(sessionResult, () => null),
          hasSessionError: sessionResult._tag === "Failure",
        },
        keepMarked,
      );
      if (!access.canReadDiagnostics) {
        statuses.push({
          environmentId,
          label: presentation.entry.target.label,
          isConnected: presentation.connection.phase === "connected",
          ...access,
          accessRequests: [],
          summary: null,
        });
        continue;
      }
      const result = get(
        serverEnvironment.usageSummary({
          environmentId,
          input: usageSummaryInput(
            input,
            get(serverEnvironment.usageModelFilterAtom(environmentId)),
          ),
        }),
      );
      const summary = AsyncResult.getOrElse(result, () => null);
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        isConnected: presentation.connection.phase === "connected",
        canReadDiagnostics: true,
        accessRequests: unansweredUsageAccessRequests({
          canAnswer: sessionHasScope(sessionResult, AuthProvidersManageScope),
          summary,
          config: get(serverEnvironment.configValueAtom(environmentId)),
        }),
        error: result._tag === "Failure" ? msg("This environment could not report usage.") : null,
        summary,
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`mobile-usage:window:${windowKey}`)),
);

/** Every environment usage can come from, without asking any of them for usage. */
const usageEnvironmentsAtom = Atom.make((get): readonly EnvironmentUsageStatus[] =>
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, presentation]) => ({
    environmentId,
    label: presentation.entry.target.label,
    isPending: true,
    isConnected: presentation.connection.phase === "connected",
    canReadDiagnostics: false,
    accessRequests: [],
    error: null,
    summary: null,
  })),
).pipe(Atom.withLabel("mobile-usage:environments"));

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];

  readonly isPending: boolean;

  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  /** Off, it lists the environments without loading their usage. */
  load = true,
): UsageView {
  const windowKey = useMemo(
    () =>
      JSON.stringify({
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
        resolution: input.resolution,
        sinceTime: input.sinceTime,
        untilTime: input.untilTime,
      }),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
    ],
  );
  const messages = useMessages();
  const markedEnvironments = useAtomValue(
    load ? usageByWindowAtom(windowKey) : usageEnvironmentsAtom,
  );
  const environments = useMemo(
    () =>
      markedEnvironments.map((environment) =>
        environment.error === null
          ? environment
          : { ...environment, error: messages(environment.error) },
      ),
    [markedEnvironments, messages],
  );
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter(({ environmentId }) => selectedEnvironmentIds.has(environmentId)),
    [environments, selectedEnvironmentIds],
  );

  const refresh = useCallback(
    (nextInput?: UsageSummaryInput) =>
      refreshUsage({
        registry: appAtomRegistry,
        server: serverEnvironment,
        presentations: environmentPresentations,

        environmentIds: selectedEnvironments
          .filter(
            (environment) =>
              environment.canReadDiagnostics &&
              readEnvironmentScope(environment.environmentId, AuthDiagnosticsReadScope),
          )
          .map(({ environmentId }) => environmentId),
        input: nextInput ?? (JSON.parse(windowKey) as UsageSummaryInput),
      }),
    [selectedEnvironments, windowKey],
  );

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = selectedEnvironments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: environment.summary,
            },
          ],
    );
    return mergeUsage(answered, USAGE_CONTRACT_VERSION);
  }, [selectedEnvironments]);

  const answeredCount = selectedEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = selectedEnvironments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
