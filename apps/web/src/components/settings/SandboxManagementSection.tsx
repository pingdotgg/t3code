import { BoxIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SandboxProviderInfo, SandboxRecord } from "@t3tools/contracts";

import { serverEnvironment } from "~/state/server";
import { useSandboxProvisionerEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./settingsLayout";
import {
  describeSandboxFailure,
  SandboxQuotaLine,
  SandboxStartBlocked,
  SandboxStartConfirmation,
  useSandboxStartCheck,
} from "./SandboxStartLimits";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";

const DEADLINE = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const stateLabel = (sandbox: SandboxRecord): string => {
  switch (sandbox.state) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "provisioning":
      return "Provisioning";
    case "error":
      return "Error";
    case "deleted":
      return "Deleted";
  }
};

export function SandboxManagementSection() {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const list = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesList({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  const providersQuery = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesProviders({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  const sandboxes = list.data?.sandboxes ?? [];
  if (provisionerEnvironmentId === null || sandboxes.length === 0) return null;

  return (
    <SettingsSection id="sandboxes" title="Sandboxes">
      {list.error ? <p className="px-1 pb-2 text-xs text-destructive">{list.error}</p> : null}
      {sandboxes.map((sandbox) => (
        <SandboxRow
          key={sandbox.environmentId}
          environmentId={provisionerEnvironmentId}
          sandbox={sandbox}
          provider={providersQuery.data?.providers.find(
            (candidate) => candidate.kind === sandbox.provider,
          )}
          onChanged={() => void list.refresh()}
        />
      ))}
    </SettingsSection>
  );
}

function SandboxRow({
  environmentId,
  sandbox,
  provider,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly sandbox: SandboxRecord;
  readonly provider: SandboxProviderInfo | undefined;
  readonly onChanged: () => void;
}) {
  const stopSandbox = useAtomCommand(serverEnvironment.sandboxesStop, { reportFailure: false });
  const resumeSandbox = useAtomCommand(serverEnvironment.sandboxesResume, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  // Only a stopped sandbox can spend a start, so only it reads the provider's limits.
  const startCheck = useSandboxStartCheck({
    environmentId,
    provider: sandbox.state === "stopped" ? provider : undefined,
  });
  // Until providers load, keep the controls; the server refuses what the driver cannot do.
  const canStopResume = provider?.capabilities.stopResume ?? true;

  const run = async (action: "stop" | "resume") => {
    startCheck.cancel();
    setPending(true);
    const input = { environmentId, input: { environmentId: sandbox.environmentId } };
    const result = action === "stop" ? await stopSandbox(input) : await resumeSandbox(input);
    setPending(false);
    if (action === "resume") startCheck.refresh();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = describeSandboxFailure(
          squashAtomCommandFailure(result),
          action === "stop" ? "Could not stop sandbox" : "Could not resume sandbox",
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failure.title,
            description: failure.description,
          }),
        );
      }
      return;
    }
    onChanged();
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground">
            <BoxIcon aria-hidden className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{sandbox.label}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {provider?.label ?? sandbox.provider} · {sandbox.size} · {stateLabel(sandbox)}
              {sandbox.hardDeadlineAt === null
                ? ""
                : ` · expires ${DEADLINE.format(new Date(sandbox.hardDeadlineAt))}`}
            </p>
            {startCheck.limits === null ? null : <SandboxQuotaLine limits={startCheck.limits} />}
          </div>
        </div>
        {canStopResume ? (
          <div className="flex shrink-0 items-center gap-2">
            {sandbox.state === "running" || sandbox.state === "error" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => void run("stop")}
              >
                {pending ? <Spinner className="size-3" /> : <SquareIcon className="size-3" />}
                Stop
              </Button>
            ) : null}
            {sandbox.state === "stopped" && !startCheck.isConfirming ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending || startCheck.blocked !== null}
                onClick={() =>
                  startCheck.needsConfirmation ? startCheck.confirm() : void run("resume")
                }
              >
                {pending ? <Spinner className="size-3" /> : <PlayIcon className="size-3" />}
                Resume
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {startCheck.blocked === null ? null : (
        <SandboxStartBlocked
          reason={startCheck.blocked.reason}
          billingUrl={startCheck.limits?.billingUrl}
        />
      )}
      {startCheck.isConfirming && !pending ? (
        <SandboxStartConfirmation
          warnings={startCheck.assessment?.warnings ?? []}
          confirmLabel="Resume anyway"
          onConfirm={() => void run("resume")}
          onCancel={startCheck.cancel}
        />
      ) : null}
    </div>
  );
}
