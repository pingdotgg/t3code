import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  OrchestrationV2ResolveImportSessionResult,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import type * as Cause from "effect/Cause";
import { useCallback, useEffect, useRef, useState } from "react";

import { inferProjectTitleFromPath } from "~/lib/projectPaths";
import { newProjectId } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import {
  describeImportSessionStep,
  type ImportSessionProviderOption,
} from "./CommandPalette.logic";
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
import { Input } from "./ui/input";

interface ImportSessionDialogProps {
  open: boolean;
  projectRef: ScopedProjectRef;
  providerOptions: ReadonlyArray<ImportSessionProviderOption>;
  onOpenChange: (open: boolean) => void;
}

function failureMessage(
  result: { readonly cause: Cause.Cause<unknown> },
  fallback: string,
): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function ImportSessionDialog({
  open,
  projectRef,
  providerOptions,
  onOpenChange,
}: ImportSessionDialogProps) {
  const navigate = useNavigate();
  const externalIdInputRef = useRef<HTMLInputElement>(null);
  const [driverKind, setDriverKind] = useState(providerOptions[0]?.driverKind);
  const [externalId, setExternalId] = useState("");
  const [externalIdDirty, setExternalIdDirty] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resolved, setResolved] = useState<OrchestrationV2ResolveImportSessionResult | null>(null);
  const importInFlightRef = useRef(false);
  const externalIdRef = useRef("");
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const resolveImportSession = useAtomCommand(threadEnvironment.resolveImportSession, {
    reportFailure: false,
  });
  const importSession = useAtomCommand(threadEnvironment.importSession, { reportFailure: false });

  const selectedOption =
    providerOptions.find((option) => option.driverKind === driverKind) ?? providerOptions[0];
  const step = describeImportSessionStep(resolved);

  const stopImporting = useCallback((message: string | null) => {
    importInFlightRef.current = false;
    setIsImporting(false);
    setErrorMessage(message);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      externalIdInputRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const handleImport = useCallback(async () => {
    if (importInFlightRef.current) {
      return;
    }
    const trimmedExternalId = externalId.trim();
    externalIdRef.current = trimmedExternalId;
    if (!selectedOption || trimmedExternalId.length === 0) {
      setExternalIdDirty(true);
      return;
    }
    importInFlightRef.current = true;
    setErrorMessage(null);
    setIsImporting(true);

    let session = resolved?.externalId === trimmedExternalId ? resolved : null;
    if (session === null) {
      const resolveResult = await resolveImportSession({
        environmentId: projectRef.environmentId,
        input: {
          instanceId: selectedOption.modelSelection.instanceId,
          externalId: trimmedExternalId,
        },
      });
      if (resolveResult._tag === "Failure") {
        return stopImporting(failureMessage(resolveResult, "Could not find that session."));
      }
      if (externalIdRef.current !== trimmedExternalId) {
        return stopImporting(null);
      }
      session = resolveResult.value;
      setResolved(session);
      if (session.projectId === null && session.workspaceRoot !== null) {
        return stopImporting(null);
      }
    }

    let projectId = session.projectId ?? projectRef.projectId;
    let createdProjectId: ProjectId | null = null;
    if (session.projectId === null && session.workspaceRoot !== null) {
      createdProjectId = newProjectId();
      const createResult = await createProject({
        environmentId: projectRef.environmentId,
        input: {
          projectId: createdProjectId,
          title: inferProjectTitleFromPath(session.workspaceRoot),
          workspaceRoot: session.workspaceRoot,
          defaultModelSelection: selectedOption.modelSelection,
        },
      });
      if (createResult._tag === "Failure") {
        return stopImporting(
          failureMessage(createResult, `Could not add ${session.workspaceRoot} as a project.`),
        );
      }
      projectId = createdProjectId;
      session = { ...session, projectId: createdProjectId };
      setResolved(session);
    }

    const importResult = await importSession({
      environmentId: projectRef.environmentId,
      input: {
        projectId,
        modelSelection: selectedOption.modelSelection,
        externalId: trimmedExternalId,
      },
    });
    if (importResult._tag === "Failure") {
      // "Add project & import" is presented as one action: if the import
      // half fails, take the freshly created project back out so retrying
      // does not leave orphan projects behind. Best effort — the import
      // error is what the user needs to see.
      if (createdProjectId !== null) {
        await deleteProject({
          environmentId: projectRef.environmentId,
          input: { projectId: createdProjectId },
        });
        session = { ...session, projectId: null };
        setResolved(session);
      }
      return stopImporting(failureMessage(importResult, "Could not import that session."));
    }

    stopImporting(null);
    onOpenChange(false);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(projectRef.environmentId, importResult.value.threadId),
      ),
    });
  }, [
    createProject,
    deleteProject,
    externalId,
    importSession,
    navigate,
    onOpenChange,
    projectRef,
    resolveImportSession,
    resolved,
    selectedOption,
    stopImporting,
  ]);

  const validationMessage =
    externalIdDirty && externalId.trim().length === 0
      ? `Paste the ${selectedOption?.fieldLabel.toLowerCase() ?? "session id"} you want to continue.`
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isImporting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import session</DialogTitle>
          <DialogDescription>
            Continue a Claude Code or Codex session that already exists on this machine. Its
            conversation is copied into a new thread in the project it ran in, and the next turn
            resumes it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex gap-1.5">
            {providerOptions.map((option) => (
              <Button
                key={option.driverKind}
                type="button"
                size="sm"
                variant={option.driverKind === selectedOption?.driverKind ? "default" : "outline"}
                onClick={() => {
                  setDriverKind(option.driverKind);
                  setResolved(null);
                  setErrorMessage(null);
                }}
                disabled={isImporting}
              >
                {option.label}
              </Button>
            ))}
          </div>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">
              {selectedOption?.fieldLabel ?? "Session ID"}
            </span>
            <Input
              ref={externalIdInputRef}
              placeholder={selectedOption?.placeholder ?? ""}
              value={externalId}
              disabled={isImporting}
              onChange={(event) => {
                setExternalIdDirty(true);
                setExternalId(event.target.value);
                externalIdRef.current = event.target.value.trim();
                setResolved(null);
                setErrorMessage(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                event.preventDefault();
                if (!isImporting) {
                  void handleImport();
                }
              }}
            />
            <span className="text-muted-foreground text-xs">{selectedOption?.hint ?? ""}</span>
          </label>

          {step.notice ? <p className="text-foreground text-xs">{step.notice}</p> : null}

          {(validationMessage ?? errorMessage) ? (
            <p className="text-destructive text-xs">{validationMessage ?? errorMessage}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isImporting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleImport();
            }}
            disabled={!selectedOption || isImporting}
          >
            {isImporting ? "Importing..." : step.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
