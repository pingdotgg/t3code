import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  CONTRIBUTOR_BUNDLE_FILE_NAME,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestrationV2PreviewSpecialistTemplateResult,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedProjectRef,
  type SpecialistTemplateSource,
  WORKSHOP_TEAM_TEMPLATE,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { useRouter } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { useComposerDraftStore } from "../composerDraftStore";
import { useContributorBundleFile } from "../hooks/useContributorBundleFile";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, subscribeProject, useProject } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";
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
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

interface AddSpecialistsFromTemplateRequest {
  readonly projectRef: ScopedProjectRef;
  readonly source?: SpecialistTemplateSource;
}

const useRequest = create<{ request: AddSpecialistsFromTemplateRequest | null; session: number }>(
  () => ({
    request: null,
    session: 0,
  }),
);

let endRequestWithProject: (() => void) | null = null;

function closeAddSpecialistsFromTemplate() {
  endRequestWithProject?.();
  endRequestWithProject = null;
  useRequest.setState({ request: null });
}

/** Opens the preflight dialog for adding specialists from Workshop or a repo bundle. */
export function openAddSpecialistsFromTemplate(request: AddSpecialistsFromTemplateRequest) {
  if (readProject(request.projectRef) === null) return;
  endRequestWithProject?.();
  endRequestWithProject = subscribeProject(request.projectRef, (project) => {
    if (project === null) closeAddSpecialistsFromTemplate();
  });
  useRequest.setState((state) => ({ request, session: state.session + 1 }));
}

export function AddSpecialistsFromTemplateDialogHost() {
  const request = useRequest((state) => state.request);
  const session = useRequest((state) => state.session);
  return request ? <AddSpecialistsFromTemplateDialog key={session} request={request} /> : null;
}

function runtimeModeLabel(mode: RuntimeMode): string {
  switch (mode) {
    case "full-access":
      return "Full access";
    case "auto":
      return "Auto";
    case "auto-accept-edits":
      return "Auto-accept edits";
    case "approval-required":
      return "Approval required";
    default:
      return mode;
  }
}

function interactionModeLabel(mode: ProviderInteractionMode): string {
  switch (mode) {
    case "default":
      return "Default tools";
    case "plan":
      return "Plan mode";
    default:
      return mode;
  }
}

function modelLabel(selection: ModelSelection): string {
  return selection.model;
}

function sourceKey(source: SpecialistTemplateSource): string {
  return source.kind === "builtin" ? `builtin:${source.templateId}` : source.kind;
}

function AddSpecialistsFromTemplateDialog({
  request,
}: {
  request: AddSpecialistsFromTemplateRequest;
}) {
  const id = useId();
  const router = useRouter();
  const project = useProject(request.projectRef);
  const bundleFile = useContributorBundleFile(
    request.projectRef.environmentId,
    project?.workspaceRoot ?? null,
  );
  const previewCommand = useAtomCommand(threadEnvironment.previewSpecialistTemplate, {
    reportFailure: false,
  });
  const addCommand = useAtomCommand(threadEnvironment.addSpecialistsFromTemplate, {
    reportFailure: false,
  });
  const [openedAt] = useState(() => Date.now());

  const defaultSource: SpecialistTemplateSource =
    request.source ??
    (bundleFile.status === "valid"
      ? { kind: "contributor-bundle" }
      : { kind: "builtin", templateId: WORKSHOP_TEAM_TEMPLATE.id });
  const [source, setSource] = useState<SpecialistTemplateSource>(defaultSource);
  const [loadedPreview, setLoadedPreview] = useState<{
    readonly key: string;
    readonly result: OrchestrationV2PreviewSpecialistTemplateResult | null;
    readonly error: string | null;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const activeSourceKey = sourceKey(source);
  const previewMatches = loadedPreview?.key === activeSourceKey;
  const preview = previewMatches ? loadedPreview.result : null;
  const previewError = previewMatches ? loadedPreview.error : null;
  const previewPending = !previewMatches;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load server preview when source/project changes
  useEffect(() => {
    if (project === null) return;
    let cancelled = false;
    const key = activeSourceKey;
    void previewCommand({
      environmentId: request.projectRef.environmentId,
      input: { projectId: project.id, source },
    }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        setLoadedPreview({
          key,
          result: null,
          error: error instanceof Error ? error.message : "Could not preview template.",
        });
        return;
      }
      setLoadedPreview({ key, result: result.value, error: null });
    });
    return () => {
      cancelled = true;
    };
  }, [activeSourceKey, previewCommand, project, request.projectRef.environmentId, source]);

  if (project === null) return null;

  const environmentServerConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
  const serverConfig = environmentServerConfigs.get(request.projectRef.environmentId);
  const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const projectSettings = resolveProjectSettings(settings, project.id, project);
  const modelResolution = resolveNewThreadModelSelection({
    defaultSelection:
      projectSettings.settings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(
        serverConfig?.providers ?? [],
        settings,
        project.id,
      ),
    fallbackSelection: settings.fallbackModelSelection ?? null,
    providers: serverConfig?.providers ?? [],
    settings,
    projectId: project.id,
    now: openedAt,
  });
  const modelSelection = modelResolution.selection;
  const runtimeMode = projectSettings.settings.defaultRuntimeMode;
  const interactionMode = "default" as const;
  const hasConflicts =
    preview?.specialists.some((seat) => seat.existingThreadId !== undefined) === true;
  const canSubmit =
    !previewPending &&
    preview !== null &&
    previewError === null &&
    modelSelection !== null &&
    !hasConflicts &&
    !submitting;

  const onSubmit = async () => {
    if (modelSelection === null || preview === null) return;
    setSubmitting(true);
    const requestingRouteHref = router.state.location.href;
    const result = await addCommand({
      environmentId: request.projectRef.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        projectId: project.id,
        source,
        modelSelection,
        runtimeMode,
        interactionMode,
      },
    });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add specialists",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }

    closeAddSpecialistsFromTemplate();
    const lead =
      result.value.specialists.find((entry) => entry.specialist.key === "lead") ??
      result.value.specialists[0];
    if (router.state.location.href !== requestingRouteHref) return;
    const leadRef = scopeThreadRef(request.projectRef.environmentId, lead.threadId);
    useComposerDraftStore.getState().setPrompt(leadRef, result.value.leadPrompt);
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(leadRef),
    });
    toastManager.add({
      type: "success",
      title: `${result.value.name} specialists ready`,
      description: `${result.value.specialists.length} pinned · talk to ${lead.title}`,
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeAddSpecialistsFromTemplate();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <UsersIcon className="size-4" />
              Add specialists from template
            </span>
          </DialogTitle>
          <DialogDescription>
            Creates durable specialist bindings in {project.title}. Confirm roles, model, and
            workspace before creating.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <span id={`${id}-source`} className="text-sm font-medium text-foreground">
                Template
              </span>
              <ToggleGroup
                aria-labelledby={`${id}-source`}
                value={[source.kind === "builtin" ? "workshop" : "contributor-bundle"]}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next === "workshop") {
                    setSource({ kind: "builtin", templateId: WORKSHOP_TEAM_TEMPLATE.id });
                  } else if (next === "contributor-bundle") {
                    setSource({ kind: "contributor-bundle" });
                  }
                }}
              >
                <Toggle value="workshop">Workshop</Toggle>
                <Toggle value="contributor-bundle" disabled={bundleFile.status !== "valid"}>
                  Repo bundle
                </Toggle>
              </ToggleGroup>
              {bundleFile.status === "missing" ? (
                <p className="text-xs text-muted-foreground">
                  No {CONTRIBUTOR_BUNDLE_FILE_NAME} in this checkout.
                </p>
              ) : bundleFile.status === "invalid" ? (
                <p className="text-xs text-destructive-foreground">
                  {CONTRIBUTOR_BUNDLE_FILE_NAME} is present but invalid.
                </p>
              ) : null}
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Model</dt>
              <dd className="text-foreground">
                {modelSelection === null
                  ? "Pick a default model first"
                  : modelLabel(modelSelection)}
              </dd>
              <dt className="text-muted-foreground">Workspace</dt>
              <dd className="min-w-0 truncate text-foreground">{project.workspaceRoot}</dd>
              <dt className="text-muted-foreground">Runtime</dt>
              <dd className="text-foreground">{runtimeModeLabel(runtimeMode)}</dd>
              <dt className="text-muted-foreground">Tools</dt>
              <dd className="text-foreground">{interactionModeLabel(interactionMode)}</dd>
              <dt className="text-muted-foreground">Paid work</dt>
              <dd className="text-foreground">
                Idle until you send. No turns start automatically.
              </dd>
            </dl>

            {previewPending ? (
              <p className="text-sm text-muted-foreground">Loading template…</p>
            ) : previewError !== null ? (
              <p className="text-sm text-destructive-foreground">{previewError}</p>
            ) : preview !== null ? (
              <div className="flex flex-col gap-2">
                <div>
                  <p className="text-sm font-medium text-foreground">{preview.name}</p>
                  {preview.description !== undefined ? (
                    <p className="text-sm text-muted-foreground">{preview.description}</p>
                  ) : null}
                </div>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {preview.specialists.map((seat) => (
                    <li
                      key={seat.key}
                      className="rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium text-foreground">{seat.label}</span>
                        <code className="text-xs text-muted-foreground">{seat.key}</code>
                      </div>
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground">
                        {seat.instructions}
                      </p>
                      {seat.existingThreadId !== undefined ? (
                        <p className="mt-1 text-xs text-destructive-foreground">
                          Already bound in this project
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {hasConflicts ? (
                  <p className="text-sm text-destructive-foreground">
                    Clear or rename the existing specialist keys before adding this template again.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => closeAddSpecialistsFromTemplate()}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={() => void onSubmit()} disabled={!canSubmit}>
            {submitting ? "Adding…" : "Add specialists"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
