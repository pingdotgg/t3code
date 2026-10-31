import { BoxIcon, PlayIcon, SquareIcon, Trash2Icon } from "lucide-react";
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
import { Badge } from "../ui/badge";
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
    case "expired":
      return "Disk expired";
    case "deleted":
      return "Deleted";
  }
};

// States the user has to act on get a badge and one line on what happened.
const ATTENTION: Partial<
  Record<SandboxRecord["state"], { readonly variant: "error" | "warning"; readonly line: string }>
> = {
  error: {
    variant: "error",
    line: "The provider reported an error, or T3 Code is not answering on this sandbox.",
  },
  expired: {
    variant: "warning",
    line: "The provider no longer keeps this stopped sandbox's disk, so it cannot be resumed.",
  },
  deleted: {
    variant: "warning",
    line: "This sandbox was deleted outside T3 Code. Deleting it here only clears it from this list.",
  },
};

const formatCost = (dollars: number) =>
  dollars < 0.01 ? "under $0.01 this month" : `$${dollars.toFixed(2)} this month`;

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
  const deleteSandbox = useAtomCommand(serverEnvironment.sandboxesDelete, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [openedAt] = useState(() => Date.now());
  const pastDeadline =
    sandbox.hardDeadlineAt !== null && Date.parse(sandbox.hardDeadlineAt) <= openedAt;
  // Until providers load, keep the controls; the server refuses what the driver cannot do.
  const canStopResume = provider?.capabilities.stopResume ?? true;
  const canStop = canStopResume && (sandbox.state === "running" || sandbox.state === "error");
  const canResume = canStopResume && sandbox.state === "stopped" && !pastDeadline;
  // Offered whenever stop or resume cannot move the sandbox forward, so no state is a dead end.
  const canDelete =
    sandbox.state === "error" ||
    sandbox.state === "expired" ||
    sandbox.state === "deleted" ||
    (sandbox.state === "stopped" && !canResume) ||
    (sandbox.state === "running" && !canStop);
  // Only a stopped sandbox can spend a start, so only it reads the provider's limits.
  const startCheck = useSandboxStartCheck({
    environmentId,
    provider: canResume ? provider : undefined,
  });
  const attention = ATTENTION[sandbox.state];

  const run = async (action: "stop" | "resume" | "delete") => {
    startCheck.cancel();
    setConfirmingDelete(false);
    setPending(true);
    const input = { environmentId, input: { environmentId: sandbox.environmentId } };
    const result =
      action === "stop"
        ? await stopSandbox(input)
        : action === "resume"
          ? await resumeSandbox(input)
          : await deleteSandbox({
              environmentId,
              input: {
                provider: sandbox.provider,
                sandboxId: sandbox.sandboxId,
                environmentId: sandbox.environmentId,
              },
            });
    setPending(false);
    if (action === "resume") startCheck.refresh();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = describeSandboxFailure(
          squashAtomCommandFailure(result),
          action === "stop"
            ? "Could not stop sandbox"
            : action === "resume"
              ? "Could not resume sandbox"
              : "Could not delete sandbox",
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

  const subtitle = [
    provider?.label ?? sandbox.provider,
    sandbox.size,
    ...(attention === undefined ? [stateLabel(sandbox)] : []),
    ...(sandbox.costDollars === undefined ? [] : [formatCost(sandbox.costDollars)]),
    ...(sandbox.hardDeadlineAt === null || attention !== undefined
      ? []
      : [`expires ${DEADLINE.format(new Date(sandbox.hardDeadlineAt))}`]),
  ].join(" · ");

  return (
    <div className="space-y-2 rounded-lg border border-border/60 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground">
            <BoxIcon aria-hidden className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm font-medium text-foreground">{sandbox.label}</p>
              {attention === undefined ? null : (
                <Badge variant={attention.variant} size="sm">
                  {stateLabel(sandbox)}
                </Badge>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
            {attention === undefined ? null : (
              <p className="mt-0.5 text-xs text-muted-foreground">{attention.line}</p>
            )}
            {startCheck.limits === null ? null : <SandboxQuotaLine limits={startCheck.limits} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canStop ? (
            <Button size="xs" variant="outline" disabled={pending} onClick={() => void run("stop")}>
              {pending ? <Spinner className="size-3" /> : <SquareIcon className="size-3" />}
              Stop
            </Button>
          ) : null}
          {canResume && !startCheck.isConfirming ? (
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
          {canDelete && !confirmingDelete ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={pending}
              onClick={() =>
                // A deleted sandbox has nothing left at the provider to lose.
                sandbox.state === "deleted" ? void run("delete") : setConfirmingDelete(true)
              }
            >
              {pending ? <Spinner className="size-3" /> : <Trash2Icon className="size-3" />}
              Delete
            </Button>
          ) : null}
        </div>
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
      {confirmingDelete && !pending ? (
        <SandboxStartConfirmation
          warnings={[
            `This deletes the machine and its disk at ${provider?.label ?? sandbox.provider}. It cannot be undone.`,
          ]}
          confirmLabel="Delete sandbox"
          destructive
          onConfirm={() => void run("delete")}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : null}
    </div>
  );
}
