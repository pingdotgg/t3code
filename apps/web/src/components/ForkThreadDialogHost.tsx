import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { closeForkThreadDialog, useForkThreadDialogStore } from "../forkThreadDialog";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { newThreadId } from "../lib/utils";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { readThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { forkThread } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import {
  findInitialForkModelSelection,
  isForkModelSelectionReady,
  isSameForkModelSelection,
} from "./ForkThreadDialog.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";
import { stackedThreadToast, toastManager } from "./ui/toast";

function ForkThreadDialog({ sourceRef }: { readonly sourceRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const executeFork = useAtomCommand(forkThread, { reportFailure: false });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(sourceRef.environmentId));
  const settings = useEnvironmentSettings(sourceRef.environmentId);
  const sourceThread = readThreadShell(sourceRef);
  const sourceSelection = useMemo<ModelSelection>(
    () =>
      sourceThread
        ? {
            instanceId:
              sourceThread.session?.providerInstanceId ?? sourceThread.modelSelection.instanceId,
            model: sourceThread.modelSelection.model,
          }
        : NO_PROVIDER_MODEL_SELECTION,
    [sourceThread],
  );
  const providers = serverConfig?.providers ?? [];
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );
  const initialSelection = useMemo(
    () =>
      findInitialForkModelSelection({
        source: sourceSelection,
        entries,
        modelOptionsByInstance,
      }),
    [entries, modelOptionsByInstance, sourceSelection],
  );
  const [selection, setSelection] = useState<ModelSelection | null>(initialSelection);
  const [attempt, setAttempt] = useState(() => ({ key: null as string | null, id: newThreadId() }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSelection = selection ?? initialSelection;
  const selectionReady =
    effectiveSelection !== null &&
    isForkModelSelectionReady({ selection: effectiveSelection, entries, modelOptionsByInstance });

  const selectModel = useCallback((instanceId: ModelSelection["instanceId"], model: string) => {
    setSelection(createModelSelection(instanceId, model));
    setAttempt({ key: null, id: newThreadId() });
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (
      pending ||
      !selectionReady ||
      effectiveSelection === null ||
      isSameForkModelSelection(effectiveSelection, sourceSelection)
    )
      return;
    setPending(true);
    setError(null);
    const requestKey = JSON.stringify([effectiveSelection.instanceId, effectiveSelection.model]);
    const targetThreadId = attempt.key === requestKey ? attempt.id : newThreadId();
    if (attempt.key !== requestKey) setAttempt({ key: requestKey, id: targetThreadId });
    const result = await executeFork({
      environmentId: sourceRef.environmentId,
      input: {
        sourceThreadId: sourceRef.threadId,
        newThreadId: targetThreadId,
        modelSelection: effectiveSelection,
      },
    });
    if (result._tag === "Failure") {
      setPending(false);
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not fork this conversation.");
      }
      return;
    }

    closeForkThreadDialog();
    const targetRef = scopeThreadRef(sourceRef.environmentId, result.value.threadId);
    const navigation = await settlePromise(() =>
      navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(targetRef),
      }),
    );
    if (navigation._tag === "Failure") {
      const cause = squashAtomCommandFailure(navigation);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Conversation forked, but navigation failed",
          description: cause instanceof Error ? cause.message : "An error occurred.",
        }),
      );
    }
  }, [
    effectiveSelection,
    executeFork,
    navigate,
    pending,
    attempt,
    selectionReady,
    sourceRef,
    sourceSelection,
  ]);

  const displaySelection = effectiveSelection ?? sourceSelection;
  const hasAlternative = initialSelection !== null;
  const sourceMissing = sourceThread === null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) closeForkThreadDialog();
      }}
    >
      <DialogPopup className="w-full sm:w-[30rem]">
        <DialogHeader>
          <DialogTitle>Fork conversation</DialogTitle>
          <DialogDescription>
            Create a new thread with this conversation as context. The original thread stays
            unchanged.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">Provider and model</div>
            <ProviderModelPicker
              activeInstanceId={displaySelection.instanceId}
              model={displaySelection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerVariant="outline"
              triggerClassName="w-full max-w-none"
              triggerAriaLabel="Choose provider and model for fork"
              disabled={pending || sourceMissing}
              getModelDisabledReason={(instanceId, model) =>
                isSameForkModelSelection({ instanceId, model }, sourceSelection)
                  ? "Choose a different provider or model."
                  : null
              }
              onInstanceModelChange={selectModel}
            />
          </div>
          {sourceMissing ? (
            <p className="text-destructive text-xs">The source thread is no longer available.</p>
          ) : effectiveSelection !== null && !selectionReady ? (
            <p className="text-muted-foreground text-xs">
              The selected provider or model is no longer available. Choose another target.
            </p>
          ) : !hasAlternative ? (
            <p className="text-muted-foreground text-xs">
              No other ready provider or model is available in this environment.
            </p>
          ) : null}
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={pending} onClick={closeForkThreadDialog}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              pending ||
              sourceMissing ||
              !selectionReady ||
              effectiveSelection === null ||
              isSameForkModelSelection(effectiveSelection, sourceSelection)
            }
            onClick={() => void submit()}
          >
            {pending ? (
              <>
                <Spinner aria-hidden /> Forking…
              </>
            ) : (
              "Fork"
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ForkThreadDialogHost() {
  const sourceRef = useForkThreadDialogStore((state) => state.sourceThreadRef);
  if (sourceRef === null) return null;
  return <ForkThreadDialog key={scopedThreadKey(sourceRef)} sourceRef={sourceRef} />;
}
