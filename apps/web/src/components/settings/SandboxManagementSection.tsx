import { BoxIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { SandboxRecord } from "@t3tools/contracts";

import { serverEnvironment } from "~/state/server";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./settingsLayout";
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

const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The sandbox action failed.";

export function SandboxManagementSection() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const list = useEnvironmentQuery(
    primaryEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesList({
          environmentId: primaryEnvironmentId,
          input: undefined,
        }),
  );
  const stopSandbox = useAtomCommand(serverEnvironment.sandboxesStop, { reportFailure: false });
  const resumeSandbox = useAtomCommand(serverEnvironment.sandboxesResume, {
    reportFailure: false,
  });
  const [pendingEnvironmentId, setPendingEnvironmentId] = useState<string | null>(null);
  const sandboxes = list.data?.sandboxes ?? [];
  if (primaryEnvironmentId === null || sandboxes.length === 0) return null;

  const run = async (sandbox: SandboxRecord, action: "stop" | "resume") => {
    setPendingEnvironmentId(sandbox.environmentId);
    const result =
      action === "stop"
        ? await stopSandbox({
            environmentId: primaryEnvironmentId,
            input: { environmentId: sandbox.environmentId },
          })
        : await resumeSandbox({
            environmentId: primaryEnvironmentId,
            input: { environmentId: sandbox.environmentId },
          });
    setPendingEnvironmentId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: action === "stop" ? "Could not stop sandbox" : "Could not resume sandbox",
            description: failureMessage(squashAtomCommandFailure(result)),
          }),
        );
      }
      return;
    }
    void list.refresh();
  };

  return (
    <SettingsSection id="sandboxes" title="Sandboxes">
      {list.error ? <p className="px-1 pb-2 text-xs text-destructive">{list.error}</p> : null}
      {sandboxes.map((sandbox) => {
        const pending = pendingEnvironmentId === sandbox.environmentId;
        return (
          <div
            key={sandbox.environmentId}
            className="flex items-start justify-between gap-4 rounded-lg border border-border/60 px-4 py-3"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground">
                <BoxIcon aria-hidden className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{sandbox.label}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {sandbox.provider} · {sandbox.size} · {stateLabel(sandbox)}
                  {sandbox.hardDeadlineAt === null
                    ? ""
                    : ` · stops ${DEADLINE.format(new Date(sandbox.hardDeadlineAt))}`}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {sandbox.state === "running" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void run(sandbox, "stop")}
                >
                  {pending ? <Spinner className="size-3" /> : <SquareIcon className="size-3" />}
                  Stop
                </Button>
              ) : null}
              {sandbox.state === "stopped" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void run(sandbox, "resume")}
                >
                  {pending ? <Spinner className="size-3" /> : <PlayIcon className="size-3" />}
                  Resume
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </SettingsSection>
  );
}
