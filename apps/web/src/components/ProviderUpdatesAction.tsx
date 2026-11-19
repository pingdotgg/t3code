import { AuthProvidersManageScope, PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import {
  checkEnvironmentUpdates,
  type UpdateCheckItem,
} from "@t3tools/client-runtime/update-check";
import { useRef, useState } from "react";
import { T } from "gt-react";

import { useEnvironmentProviders, useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { isHostedByThisApp } from "~/connection/desktopLocal";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  getProviderUpdateRunToastView,
  type ProviderUpdateRun,
} from "./ProviderUpdateLaunchNotification.logic";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// `refreshModels` always drops the server's hour-long latest-version cache. `modelCatalogOnly`
// drops it only when the model manifest changed.
export function useCheckEnvironmentUpdates() {
  const { environments } = useEnvironments();
  const manageableIds = useEnvironmentsWithScope(environments, AuthProvidersManageScope);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const lookupNpmRelease = useAtomCommand(serverEnvironment.lookupNpmRelease, {
    reportFailure: false,
  });
  const inFlight = useRef<Promise<UpdateCheckItem[]> | null>(null);

  const check = () =>
    checkEnvironmentUpdates(
      environments.map((environment) => ({
        ...environment,
        hostedByThisApp: isHostedByThisApp(environment),
        canManageProviders: manageableIds.has(environment.environmentId),
      })),
      { lookupNpmRelease, refreshProviders },
    );

  // A repeat click must not start a second model rediscovery while one is running.
  return () => {
    if (inFlight.current) return inFlight.current;
    const running = check().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = running;
    return running;
  };
}

export function useProviderUpdates() {
  const { environments } = useEnvironments();
  const manageableIds = useEnvironmentsWithScope(environments, AuthProvidersManageScope);
  const providersByEnvironment = useEnvironmentProviders();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const machines = environments.flatMap((environment) => {
    const providers = providersByEnvironment.get(environment.environmentId) ?? [];
    if (
      environment.connection.phase !== "connected" ||
      !manageableIds.has(environment.environmentId)
    ) {
      return [];
    }
    const candidates = collectProviderUpdateCandidates(providers).filter((candidate) =>
      canOneClickUpdateProviderCandidate(candidate, providers),
    );
    return candidates.length > 0
      ? [{ environmentId: environment.environmentId, label: environment.label, candidates }]
      : [];
  });

  const updateAll = async ({ quiet = false }: { readonly quiet?: boolean } = {}) => {
    const runs = await Promise.all(
      machines.flatMap(({ environmentId, label, candidates }) =>
        candidates.map(async (candidate): Promise<ProviderUpdateRun> => ({
          environmentId,
          machineLabel: label,
          driver: candidate.driver,
          instanceId: candidate.instanceId,
          result: await updateProvider({
            environmentId,
            input: { provider: candidate.driver, instanceId: candidate.instanceId },
          }),
        })),
      ),
    );
    const view = quiet ? null : getProviderUpdateRunToastView(runs);
    if (view) {
      toastManager.add(
        stackedThreadToast({
          ...view,
          description: <span className="whitespace-pre-line">{view.description}</span>,
        }),
      );
    }
    return runs;
  };

  return { machines, updateAll };
}

export function ProviderUpdatesAction() {
  const { machines, updateAll } = useProviderUpdates();
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  if (machines.length === 0 && !isPending) {
    return null;
  }

  const handleUpdate = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    await settlePromise(() => updateAll());
    pending.current = false;
    setIsPending(false);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={isPending}
            onClick={() => void handleUpdate()}
          >
            {isPending ? <T>Updating…</T> : <T>Update all</T>}
          </Button>
        }
      />
      <TooltipPopup side="top">
        {machines.map((machine) => (
          <div key={machine.environmentId}>
            {machine.label}:{" "}
            {machine.candidates
              .map((candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver)
              .join(", ")}
          </div>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}
