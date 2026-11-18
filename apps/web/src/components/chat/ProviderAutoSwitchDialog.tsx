import type {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
  ThreadId,
  UnifiedSettings,
} from "@t3tools/contracts";
import { pickModelSelection } from "@t3tools/shared/model";
import {
  autoSwitchReason,
  isAutoSwitchTargetUsable,
  nextAutoSwitchTarget,
  usedPercent,
} from "@t3tools/shared/providerAutoSwitch";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { newMessageId } from "~/lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { ProviderModelPicker } from "./ProviderModelPicker";

// Opening an old thread should not ask about a limit it hit long ago.
const RECENT_RUN_MS = 60 * 60 * 1000;

/** Asks which provider takes over when the thread's provider runs low and auto-switch is set to ask. */
export function ProviderAutoSwitchDialog({
  environmentId,
  thread,
  lastErrorClass,
  providers,
  settings,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: {
    readonly id: ThreadId;
    readonly projectId: Parameters<typeof providerInstanceEntriesFor>[2];
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly latestRun: {
      readonly runId: string;
      readonly status: string;
      readonly completedAt: string | null;
    } | null;
  };
  readonly lastErrorClass: string | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [closedRunId, setClosedRunId] = useState<string | null>(null);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [mountedAt] = useState(() => Date.now());
  const setModelSelection = useOrchestrationCommand(threadEnvironment.setModelSelection, {
    label: "switch provider",
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    label: "continue on another provider",
  });
  const autoSwitch = settings.providerAutoSwitch;
  const run = thread.latestRun;
  const entries = providerInstanceEntriesFor(providers, settings, thread.projectId);
  const reason =
    autoSwitch.mode === "ask" && run !== null && run.runId !== closedRunId
      ? autoSwitchReason({
          settings: autoSwitch,
          providers,
          selection: thread.modelSelection,
          runStatus: run.status,
          lastErrorClass,
        })
      : null;
  const recent =
    run?.completedAt != null && Date.parse(run.completedAt) > mountedAt - RECENT_RUN_MS;
  if (reason === null || !recent || run === null) return null;

  const suggestion = nextAutoSwitchTarget(
    autoSwitch.route.length > 0
      ? autoSwitch
      : {
          ...autoSwitch,
          route: entries.flatMap((entry) =>
            entry.models[0] ? [{ instanceId: entry.instanceId, model: entry.models[0].slug }] : [],
          ),
        },
    providers,
    thread.modelSelection,
  );
  const target = picked ?? suggestion;
  const current = providers.find(
    (provider) => provider.instanceId === thread.modelSelection.instanceId,
  );
  const currentName =
    entries.find((entry) => entry.instanceId === thread.modelSelection.instanceId)?.displayName ??
    thread.modelSelection.instanceId;
  const used =
    autoSwitch.trigger === "exhausted"
      ? null
      : usedPercent(current, thread.modelSelection.model, autoSwitch.trigger);
  const close = () => {
    setClosedRunId(run.runId);
    setPicked(null);
  };

  const confirm = async () => {
    if (target === null) return;
    setBusy(true);
    const result =
      reason === "exhausted"
        ? await startTurn({
            environmentId,
            input: {
              threadId: thread.id,
              message: {
                messageId: newMessageId(),
                role: "user",
                text: gt("Continue where you left off."),
                attachments: [],
              },
              modelSelection: target,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt: new Date().toISOString(),
            },
          })
        : await setModelSelection({
            environmentId,
            input: { threadId: thread.id, modelSelection: target },
          });
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: gt("Could not switch provider"),
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), messages) ?? gt("Try again."),
      });
      return;
    }
    close();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Switch provider?</T>
          </DialogTitle>
          <DialogDescription>
            {reason === "exhausted"
              ? gt("{provider} reached its usage limit.", { provider: currentName })
              : gt("{provider} has used {percent}% of its limit.", {
                  provider: currentName,
                  percent: Math.round(used ?? 0),
                })}{" "}
            {gt("The thread's context moves with it.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {target === null ? (
            <p className="text-sm text-muted-foreground">
              <T>No other provider has usage left.</T>
            </p>
          ) : (
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={target.instanceId}
              model={target.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={getCustomModelOptionsByInstance(
                settings,
                providers,
                target.instanceId,
                target.model,
              )}
              triggerAriaLabel={gt("Provider to switch to")}
              getModelDisabledReason={(instanceId, model) =>
                instanceId === thread.modelSelection.instanceId
                  ? gt("This is the thread's current provider.")
                  : isAutoSwitchTargetUsable(autoSwitch, providers, { instanceId, model })
                    ? null
                    : gt("This provider is out of usage.")
              }
              onInstanceModelChange={(instanceId, model) =>
                setPicked(pickModelSelection(target, instanceId, model))
              }
            />
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close}>
            <T>Not now</T>
          </Button>
          <Button disabled={target === null || busy} onClick={() => void confirm()}>
            {reason === "exhausted" ? <T>Switch and continue</T> : <T>Switch</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
