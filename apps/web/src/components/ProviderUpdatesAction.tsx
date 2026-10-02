import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";

import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  getProviderUpdateRunToastView,
  type ProviderUpdateRun,
} from "./ProviderUpdateLaunchNotification.logic";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Updates every outdated provider on every connected machine at once, then
 * reports the results in one toast. Each server queues updates that share an
 * installer, so sending them all together is safe. The server still checks
 * permissions: a session that cannot operate a machine gets a failure line for
 * it. Renders nothing when no machine has a one-click update.
 */
export function ProviderUpdatesAction() {
  const { environments } = useEnvironments();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const machines = useMemo(
    () =>
      environments.flatMap((environment) => {
        const providers = environment.serverConfig?.providers ?? [];
        if (environment.connection.phase !== "connected") {
          return [];
        }
        const candidates = collectProviderUpdateCandidates(providers).filter((candidate) =>
          canOneClickUpdateProviderCandidate(candidate, providers),
        );
        return candidates.length > 0
          ? [{ environmentId: environment.environmentId, label: environment.label, candidates }]
          : [];
      }),
    [environments],
  );
  // Candidates leave the list as soon as their servers report them queued, so
  // keep the button while the run is in flight.
  if (machines.length === 0 && !isPending) {
    return null;
  }

  const handleUpdate = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    try {
      const runs = await Promise.all(
        machines.flatMap(({ environmentId, label, candidates }) =>
          candidates.map(async (candidate): Promise<ProviderUpdateRun> => ({
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
      const view = getProviderUpdateRunToastView(runs);
      if (view) {
        toastManager.add(
          stackedThreadToast({
            ...view,
            description: <span className="whitespace-pre-line">{view.description}</span>,
          }),
        );
      }
    } finally {
      pending.current = false;
      setIsPending(false);
    }
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
            {isPending ? "Updating…" : "Update all"}
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
