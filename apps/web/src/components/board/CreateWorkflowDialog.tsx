import type {
  AgentSelection,
  BoardId,
  BoardTemplateSummary,
  EnvironmentApi,
  ProjectId,
  ProviderInstanceId,
  ProviderOptionSelection,
  WorkflowDefinitionEncoded,
  WorkflowLintError,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { usePrimarySettings } from "~/hooks/useSettings";
import { getAppModelOptionsForInstance, type AppModelOption } from "~/modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "~/providerInstances";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerProvidersAtom } from "~/state/server";
import { nextDefaultBoardName } from "~/components/Sidebar.logic";
import {
  decodeAutoPullRule,
  effectiveAutoPullRule,
  summarizeAutoPull,
} from "@t3tools/contracts/workSource";
import {
  createWorkflowBoard,
  generateWorkflowDraft,
  listBoardTemplates,
} from "~/workflow/boardRpc";
import { lintErrorKey } from "~/workflow/editorModel";
import { resolveRecentAgent } from "~/workflow/resolveRecentAgent";

import { ImportBoardDialog } from "./ImportBoardDialog";
import { SourceWizard } from "./editor/SourceWizard";
import type { WorkflowLaneEncoded } from "./editor/WorkflowEditor";

export interface CreateWorkflowDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The target project member's project id (passed to BOTH generate + create). */
  readonly projectId: ProjectId;
  /** The target project member's environment id (used for the import dialog). */
  readonly environmentId: string;
  /** Display name of the target project member, for context in the header. */
  readonly projectName: string;
  readonly api: EnvironmentApi;
  /** Board names that already exist for this project — seeds the default name. */
  readonly existingBoardNames: ReadonlyArray<string>;
  /** Called with the new boardId once a board is created (caller navigates). */
  readonly onCreated: (boardId: string) => void;
}

type WizardStep = "name" | "choose" | "agent" | "source";

/** Mirrors the server contract `description: isMaxLength(4000)` so the textarea
 * cannot hold a value the server will reject. */
const DESCRIPTION_MAX_LENGTH = 4000;

// Encoded element types derived from the wire-shape `WorkflowDefinitionEncoded`
// (`generateWorkflowDraft` returns the encoded definition). We render these, so
// we type against the encoded variants — branded keys are plain strings here.
type EncodedLane = NonNullable<WorkflowDefinitionEncoded["lanes"]>[number];
type EncodedStep = NonNullable<EncodedLane["pipeline"]>[number];
type EncodedStepRouting = NonNullable<EncodedStep["on"]>;
type EncodedAgentStep = Extract<EncodedStep, { type: "agent" }>;
type EncodedOnEvent = NonNullable<EncodedLane["onEvent"]>[number];

/** Lint errors shown inline, mirroring ImportBoardDialog's styling. */
function LintErrorList({ errors }: { readonly errors: ReadonlyArray<WorkflowLintError> }) {
  if (errors.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-destructive-foreground">
        The board definition has errors:
      </p>
      <ul className="rounded-md border border-warning/45 bg-warning/8 p-2 text-sm text-warning-foreground">
        {errors.map((err) => (
          <li key={lintErrorKey(err)}>
            <span className="font-mono text-xs opacity-70">{err.code}</span>
            {err.laneKey !== undefined ? (
              <span className="opacity-70"> · lane {String(err.laneKey)}</span>
            ) : null}
            {err.stepKey !== undefined ? (
              <span className="opacity-70"> / step {String(err.stepKey)}</span>
            ) : null}
            {" — "}
            {err.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CreateWorkflowDialog({
  open,
  onOpenChange,
  projectId,
  environmentId,
  projectName,
  api,
  existingBoardNames,
  onCreated,
}: CreateWorkflowDialogProps) {
  const [step, setStep] = useState<WizardStep>("name");
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<AgentSelection | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lintErrors, setLintErrors] = useState<ReadonlyArray<WorkflowLintError>>([]);

  // Template step
  const [templates, setTemplates] = useState<ReadonlyArray<BoardTemplateSummary> | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // Agent-assisted step
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<{
    readonly definition: WorkflowDefinitionEncoded;
    readonly rationale: string;
  } | null>(null);

  // Source step — populated after successful board creation.
  const [createdBoardId, setCreatedBoardId] = useState<BoardId | null>(null);
  const [sourceStepDefinition, setSourceStepDefinition] =
    useState<WorkflowDefinitionEncoded | null>(null);
  const [sourceStepVersionHash, setSourceStepVersionHash] = useState<string | null>(null);
  const [sourceWizardOpen, setSourceWizardOpen] = useState(false);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceLintErrors, setSourceLintErrors] = useState<ReadonlyArray<WorkflowLintError>>([]);

  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = usePrimarySettings();

  // Whether any agent provider is available. When null, agent-driven paths are
  // disabled (Empty + Import stay enabled).
  const hasAgent = useMemo(() => resolveRecentAgent(providers) !== null, [providers]);

  const instanceEntries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)),
    [providers],
  );
  const modelOptionsByInstance = useMemo(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of instanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [instanceEntries, settings]);
  const activeInstanceId = (agent?.instance ?? "") as ProviderInstanceId;
  const selectedEntry = instanceEntries.find((entry) => entry.instanceId === activeInstanceId);

  const defaultName = useMemo(() => nextDefaultBoardName(existingBoardNames), [existingBoardNames]);

  // Seed the name + recent agent each time the dialog opens; reset on close.
  useEffect(() => {
    if (open) {
      setName((current) => (current.trim().length === 0 ? defaultName : current));
      setAgent((current) => current ?? resolveRecentAgent());
    } else {
      setStep("name");
      setName("");
      setAgent(null);
      setCreating(false);
      setError(null);
      setLintErrors([]);
      setTemplates(null);
      setTemplatesLoading(false);
      setPendingTemplateId(null);
      setImportOpen(false);
      setDescription("");
      setGenerating(false);
      setDraft(null);
      setCreatedBoardId(null);
      setSourceStepDefinition(null);
      setSourceStepVersionHash(null);
      setSourceWizardOpen(false);
      setSourceSaving(false);
      setSourceError(null);
      setSourceLintErrors([]);
    }
  }, [open, defaultName]);

  const clearFeedback = () => {
    setError(null);
    setLintErrors([]);
  };

  const trimmedName = name.trim();

  // Apply a create result: on success, transition to the source step; on failure,
  // surface message/lint errors.
  const applyCreateResult = (result: Awaited<ReturnType<typeof createWorkflowBoard>>) => {
    if (result.ok) {
      const boardId = result.boardId;
      setCreatedBoardId(boardId);
      // Fetch the board definition so the SourceWizard can build a well-typed lanes list.
      void api.workflow
        .getBoardDefinition({ boardId })
        .then(({ definition, versionHash }) => {
          setSourceStepDefinition(definition);
          setSourceStepVersionHash(versionHash);
        })
        .catch((cause: unknown) => {
          // If the fetch fails we still advance to the source step; the user can skip.
          setSourceError(
            cause instanceof Error ? cause.message : "Could not load board definition.",
          );
        });
      setStep("source");
      return;
    }
    setLintErrors(result.lintErrors);
    if (result.message !== undefined) {
      setError(result.message);
    }
  };

  /** Finish board creation — navigate to the board and close the dialog. */
  const finishCreation = (boardId: BoardId) => {
    onCreated(boardId);
    onOpenChange(false);
  };

  /** Save the new source onto the already-created board, then navigate. */
  const handleSourceSave = async (
    source: NonNullable<WorkflowDefinitionEncoded["sources"]>[number],
  ) => {
    if (!createdBoardId) return;
    setSourceSaving(true);
    setSourceError(null);
    setSourceLintErrors([]);

    // Snapshot current definition + version (may be retried on conflict).
    let definition = sourceStepDefinition;
    let versionHash = sourceStepVersionHash;

    // If the definition hasn't loaded yet, try a fresh fetch.
    if (definition === null || versionHash === null) {
      try {
        const fetched = await api.workflow.getBoardDefinition({ boardId: createdBoardId });
        definition = fetched.definition;
        versionHash = fetched.versionHash;
        setSourceStepDefinition(definition);
        setSourceStepVersionHash(versionHash);
      } catch (cause) {
        setSourceError(cause instanceof Error ? cause.message : "Could not load board definition.");
        setSourceSaving(false);
        return;
      }
    }

    const updatedDefinition: WorkflowDefinitionEncoded = {
      ...definition,
      sources: [...(definition.sources ?? []), source],
    };

    try {
      const result = await api.workflow.saveBoardDefinition({
        boardId: createdBoardId,
        definition: updatedDefinition,
        expectedVersionHash: versionHash,
      });
      if (result.ok) {
        finishCreation(createdBoardId);
        return;
      }
      if ("conflict" in result && result.conflict) {
        // Optimistic-concurrency conflict: re-fetch and retry once.
        try {
          const fetched = await api.workflow.getBoardDefinition({ boardId: createdBoardId });
          setSourceStepDefinition(fetched.definition);
          setSourceStepVersionHash(fetched.versionHash);
          setSourceError(
            "The board was updated concurrently. The source wizard has been reset with the latest definition — please click 'Set up a source' again.",
          );
        } catch {
          setSourceError("Version conflict and could not re-fetch the board definition.");
        }
        return;
      }
      // Lint errors.
      if ("lintErrors" in result) {
        setSourceLintErrors(result.lintErrors);
        setSourceError("The source configuration has validation errors (see below).");
        return;
      }
      setSourceError("Saving the source failed for an unknown reason.");
    } catch (cause) {
      setSourceError(cause instanceof Error ? cause.message : "Saving the source failed.");
    } finally {
      setSourceSaving(false);
    }
  };

  const createEmpty = async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    clearFeedback();
    try {
      const result = await createWorkflowBoard(api, {
        projectId,
        name: trimmedName,
        choice: { kind: "empty" },
      });
      applyCreateResult(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Creating the board failed.");
    } finally {
      setCreating(false);
    }
  };

  const createFromTemplate = async (template: BoardTemplateSummary) => {
    if (creating) {
      return;
    }
    setCreating(true);
    clearFeedback();
    try {
      const result = await createWorkflowBoard(api, {
        projectId,
        name: trimmedName,
        choice: {
          kind: "template",
          templateId: template.id,
          ...(template.requiresAgent && agent !== null ? { agent } : {}),
        },
      });
      applyCreateResult(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Creating the board failed.");
    } finally {
      setCreating(false);
      setPendingTemplateId(null);
    }
  };

  const loadTemplates = async () => {
    setTemplatesLoading(true);
    clearFeedback();
    try {
      const result = await listBoardTemplates(api);
      setTemplates(result.templates);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Loading templates failed.");
    } finally {
      setTemplatesLoading(false);
    }
  };

  const generate = async () => {
    const trimmedDescription = description.trim();
    if (generating || agent === null || trimmedDescription.length === 0) {
      return;
    }
    setGenerating(true);
    clearFeedback();
    setDraft(null);
    try {
      const result = await generateWorkflowDraft(api, {
        projectId,
        name: trimmedName,
        description: trimmedDescription,
        agent,
      });
      if (result.ok) {
        setDraft({ definition: result.definition, rationale: result.rationale });
      } else {
        setError(result.message);
        if (result.lintErrors !== undefined) {
          setLintErrors(result.lintErrors);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Generating the workflow failed.");
    } finally {
      setGenerating(false);
    }
  };

  const createFromDraft = async () => {
    if (creating || draft === null) {
      return;
    }
    setCreating(true);
    clearFeedback();
    try {
      const result = await createWorkflowBoard(api, {
        projectId,
        name: trimmedName,
        choice: { kind: "definition", definition: draft.definition },
      });
      applyCreateResult(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Creating the board failed.");
    } finally {
      setCreating(false);
    }
  };

  const agentPicker = (disabled: boolean) => (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">Agent</span>
      <div className="flex flex-wrap items-center gap-2" data-testid="create-workflow-agent">
        <ProviderModelPicker
          activeInstanceId={activeInstanceId}
          model={agent?.model ?? ""}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          triggerVariant="outline"
          disabled={disabled}
          onInstanceModelChange={(instanceId, model) => {
            setAgent((current) => ({
              ...(current?.options === undefined ? {} : { options: current.options }),
              instance: instanceId,
              model,
            }));
          }}
        />
        {selectedEntry && agent ? (
          <TraitsPicker
            provider={selectedEntry.driverKind}
            instanceId={selectedEntry.instanceId}
            models={selectedEntry.models}
            model={agent.model}
            modelOptions={agent.options as ReadonlyArray<ProviderOptionSelection> | undefined}
            prompt=""
            onPromptChange={() => {}}
            allowPromptInjectedEffort={false}
            triggerVariant="outline"
            disabled={disabled}
            onModelOptionsChange={(nextOptions) => {
              setAgent((current) =>
                current === null
                  ? current
                  : {
                      instance: current.instance,
                      model: current.model,
                      ...(nextOptions === undefined || nextOptions.length === 0
                        ? {}
                        : { options: nextOptions }),
                    },
              );
            }}
          />
        ) : null}
        {agent === null ? (
          <span className="text-xs text-muted-foreground">No agent provider available.</span>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          // If the dialog is being closed while a board has already been
          // created (we're on the source step), route through finishCreation
          // so onCreated always fires — even when the user dismisses via
          // X / Escape / backdrop instead of Skip / Done.
          if (!nextOpen && createdBoardId !== null) {
            finishCreation(createdBoardId);
            return;
          }
          onOpenChange(nextOpen);
        }}
      >
        <DialogPopup className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-hidden">
          <div className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>Create workflow board</DialogTitle>
              <DialogDescription>
                {step === "name"
                  ? `Name the board for ${projectName}.`
                  : step === "choose"
                    ? "Start empty, pick a template, or let an agent draft it for you."
                    : step === "source"
                      ? "Your board is ready. Optionally connect a work source to start pulling in issues."
                      : "Describe how you work — an agent drafts a board you can review before creating."}
              </DialogDescription>
            </DialogHeader>

            <div
              className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-1 pb-3"
              data-slot="dialog-panel"
            >
              {step === "name" ? (
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-foreground" htmlFor="board-name">
                    Board name
                  </label>
                  <Input
                    id="board-name"
                    value={name}
                    autoFocus
                    placeholder="Board name"
                    onChange={(event) => setName(event.currentTarget.value)}
                    aria-label="Board name"
                  />
                </div>
              ) : null}

              {step === "choose" ? (
                <div className="space-y-2" data-testid="create-workflow-choices">
                  <button
                    type="button"
                    className="w-full rounded-md border border-border/70 bg-card/35 p-3 text-left hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={creating}
                    onClick={() => void createEmpty()}
                  >
                    <p className="text-sm font-medium text-foreground">Empty board</p>
                    <p className="text-xs text-muted-foreground">
                      Start with a blank board and add lanes yourself.
                    </p>
                  </button>

                  <button
                    type="button"
                    className="w-full rounded-md border border-border/70 bg-card/35 p-3 text-left hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={creating}
                    onClick={() => {
                      clearFeedback();
                      if (templates === null && !templatesLoading) {
                        void loadTemplates();
                      }
                    }}
                  >
                    <p className="text-sm font-medium text-foreground">From a template</p>
                    <p className="text-xs text-muted-foreground">
                      Pick a starting point or import a workflow file.
                    </p>
                  </button>

                  {templatesLoading ? (
                    <p className="px-1 text-xs text-muted-foreground">Loading templates…</p>
                  ) : null}

                  {templates !== null ? (
                    <ul className="space-y-2 pl-3" data-testid="create-workflow-templates">
                      {templates.map((template) => {
                        const templateDisabled = creating || (template.requiresAgent && !hasAgent);
                        return (
                          <li key={template.id}>
                            <button
                              type="button"
                              className="w-full rounded-md border border-border/60 bg-background p-2.5 text-left hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={templateDisabled}
                              title={
                                template.requiresAgent && !hasAgent
                                  ? "Connect an agent to use this"
                                  : undefined
                              }
                              onClick={() => {
                                setPendingTemplateId(template.id);
                                void createFromTemplate(template);
                              }}
                            >
                              <p className="text-sm font-medium text-foreground">
                                {template.name}
                                {creating && pendingTemplateId === template.id
                                  ? " — creating…"
                                  : ""}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {template.description}
                              </p>
                              {template.requiresAgent && !hasAgent ? (
                                <p className="mt-1 text-[11px] text-muted-foreground/80">
                                  Connect an agent to use this
                                </p>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                      <li>
                        <button
                          type="button"
                          className="w-full rounded-md border border-dashed border-border/60 bg-background p-2.5 text-left hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={creating}
                          onClick={() => setImportOpen(true)}
                        >
                          <p className="text-sm font-medium text-foreground">Import from file…</p>
                          <p className="text-xs text-muted-foreground">
                            Load a board definition from JSON.
                          </p>
                        </button>
                      </li>
                    </ul>
                  ) : null}

                  <button
                    type="button"
                    className="w-full rounded-md border border-border/70 bg-card/35 p-3 text-left hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={creating || !hasAgent}
                    title={hasAgent ? undefined : "Connect an agent to use this"}
                    onClick={() => {
                      clearFeedback();
                      setStep("agent");
                    }}
                  >
                    <p className="text-sm font-medium text-foreground">Agent-assisted</p>
                    <p className="text-xs text-muted-foreground">
                      Describe your workflow and an agent drafts a board.
                    </p>
                    {hasAgent ? null : (
                      <p className="mt-1 text-[11px] text-muted-foreground/80">
                        Connect an agent to use this
                      </p>
                    )}
                  </button>
                </div>
              ) : null}

              {step === "agent" ? (
                draft === null ? (
                  <>
                    {agentPicker(generating)}
                    <div className="grid gap-1.5">
                      <label
                        className="text-xs font-medium text-foreground"
                        htmlFor="workflow-description"
                      >
                        Describe how you work with your agents
                      </label>
                      <Textarea
                        id="workflow-description"
                        value={description}
                        rows={8}
                        maxLength={DESCRIPTION_MAX_LENGTH}
                        placeholder="e.g. I want plan → implement → review → merge, with an approval gate before merging…"
                        onChange={(event) => setDescription(event.currentTarget.value)}
                        aria-label="Workflow description"
                        disabled={generating}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {DESCRIPTION_MAX_LENGTH - description.length} characters remaining
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="space-y-3" data-testid="create-workflow-review">
                    <h3 className="text-sm font-semibold text-foreground">
                      Review: {trimmedName.length > 0 ? trimmedName : name}
                    </h3>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-foreground">Rationale</p>
                      <p className="whitespace-pre-wrap rounded-md border border-border/70 bg-card/35 p-3 text-sm text-foreground">
                        {draft.rationale}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-foreground">What this board will do</p>
                      <p className="text-[11px] text-muted-foreground">
                        Review every lane, agent instruction, and route below before creating — this
                        is exactly what the agents will be told to do.
                      </p>
                      <DraftSummary definition={draft.definition} />
                    </div>
                  </div>
                )
              ) : null}

              {step === "source" ? (
                <div className="space-y-3" data-testid="create-workflow-source-step">
                  <div className="rounded-md border border-border/70 bg-card/35 p-4 space-y-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">Connect a work source</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Work sources pull issues from GitHub or Asana into your board automatically.
                        You can always add one later from the editor.
                      </p>
                    </div>
                    {sourceStepDefinition !== null ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={sourceSaving}
                        onClick={() => setSourceWizardOpen(true)}
                      >
                        Set up a source
                      </Button>
                    ) : sourceError !== null ? null : (
                      <p className="text-xs text-muted-foreground">Loading board definition…</p>
                    )}
                  </div>
                  {sourceError !== null ? (
                    <p className="text-xs text-destructive-foreground" role="alert">
                      {sourceError}
                    </p>
                  ) : null}
                  <LintErrorList errors={sourceLintErrors} />
                </div>
              ) : null}

              {error !== null ? (
                <p className="text-xs text-destructive-foreground" role="alert">
                  {error}
                </p>
              ) : null}
              <LintErrorList errors={lintErrors} />
            </div>

            <DialogFooter>
              {step === "name" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenChange(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={trimmedName.length === 0}
                    onClick={() => {
                      clearFeedback();
                      setStep("choose");
                    }}
                  >
                    Next
                  </Button>
                </>
              ) : null}

              {step === "choose" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={creating}
                  onClick={() => {
                    clearFeedback();
                    setStep("name");
                  }}
                >
                  Back
                </Button>
              ) : null}

              {step === "agent" ? (
                draft === null ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={generating}
                      onClick={() => {
                        clearFeedback();
                        setStep("choose");
                      }}
                    >
                      Back
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={generating || agent === null || description.trim().length === 0}
                      onClick={() => void generate()}
                    >
                      {generating ? "Generating…" : "Generate"}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={creating}
                      onClick={() => {
                        clearFeedback();
                        setDraft(null);
                      }}
                    >
                      Discard
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={creating || generating}
                      onClick={() => void generate()}
                    >
                      {generating ? "Generating…" : "Regenerate"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={creating}
                      onClick={() => void createFromDraft()}
                    >
                      {creating ? "Creating…" : "Create"}
                    </Button>
                  </>
                )
              ) : null}

              {step === "source" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={sourceSaving}
                    onClick={() => {
                      if (createdBoardId !== null) {
                        finishCreation(createdBoardId);
                      }
                    }}
                  >
                    Skip
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={sourceSaving}
                    onClick={() => {
                      if (createdBoardId !== null) {
                        finishCreation(createdBoardId);
                      }
                    }}
                  >
                    Done
                  </Button>
                </>
              ) : null}
            </DialogFooter>
          </div>
        </DialogPopup>
      </Dialog>

      {step === "source" && sourceStepDefinition !== null && createdBoardId !== null ? (
        <SourceWizard
          open={sourceWizardOpen}
          onOpenChange={setSourceWizardOpen}
          mode="create"
          lanes={sourceStepDefinition.lanes as ReadonlyArray<WorkflowLaneEncoded>}
          listWorkSourceConnections={api.workflow.listWorkSourceConnections}
          createWorkSourceConnection={api.workflow.createWorkSourceConnection}
          disabled={sourceSaving}
          onSave={(source) => {
            void handleSourceSave(source);
          }}
        />
      ) : null}

      <ImportBoardDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        api={api}
        projectId={projectId}
        onSuccess={(boardId) => {
          setImportOpen(false);
          onCreated(boardId);
          onOpenChange(false);
        }}
      />
    </>
  );
}

/** A small key/value row — label muted, value as escaped text. */
function MetaRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <p className="text-xs text-foreground">
      <span className="font-mono opacity-70">{label}</span>
      {" · "}
      {children}
    </p>
  );
}

/** Render a model-authored instruction. May be inline text or a file reference.
 * Long instructions are shown in full inside a scrollable <pre> block. All
 * content is escaped JSX text — never HTML. */
function StepInstructionView({
  instruction,
}: {
  readonly instruction: EncodedAgentStep["instruction"];
}) {
  if (typeof instruction === "object" && instruction !== null && "file" in instruction) {
    return (
      <MetaRow label="instruction (file)">
        <span className="font-mono">{String(instruction.file)}</span>
      </MetaRow>
    );
  }
  const text = typeof instruction === "string" ? instruction : String(instruction);
  return (
    <div className="space-y-0.5">
      <p className="font-mono text-[11px] text-muted-foreground">instruction</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-background p-2 text-xs text-foreground">
        {text}
      </pre>
    </div>
  );
}

/** Render a single pipeline step's full executable semantics, by type. */
function StepView({ step }: { readonly step: EncodedStep }) {
  return (
    <li className="rounded border border-border/50 bg-background/60 p-2">
      <p className="text-xs font-medium text-foreground">
        <span className="font-mono opacity-70">{step.type}</span>
        {" · "}
        {String(step.key)}
      </p>
      {step.type === "agent" ? (
        <div className="mt-1 space-y-1">
          <StepInstructionView instruction={step.instruction} />
          {step.captureOutput !== undefined ? (
            <MetaRow label="captureOutput">{String(step.captureOutput)}</MetaRow>
          ) : null}
          {step.panel !== undefined ? <MetaRow label="panel">{String(step.panel)}</MetaRow> : null}
          {step.retry !== undefined ? (
            <MetaRow label="retry">
              <span className="font-mono">{JSON.stringify(step.retry)}</span>
            </MetaRow>
          ) : null}
          <StepRoutingView routing={step.on} />
        </div>
      ) : step.type === "approval" ? (
        <div className="mt-1 space-y-1">
          {step.prompt !== undefined && step.prompt.length > 0 ? (
            <div className="space-y-0.5">
              <p className="font-mono text-[11px] text-muted-foreground">prompt</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-background p-2 text-xs text-foreground">
                {step.prompt}
              </pre>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">No prompt.</p>
          )}
          <StepRoutingView routing={step.on} />
        </div>
      ) : (
        // script / merge / pullRequest — show the remaining declarative fields
        // as escaped JSON so nothing is hidden.
        <div className="mt-1 space-y-1">
          <MetaRow label="config">
            <span className="font-mono break-words">{JSON.stringify(stepRest(step))}</span>
          </MetaRow>
          <StepRoutingView routing={step.on} />
        </div>
      )}
    </li>
  );
}

/** Strip the common key/type/on fields so the JSON config view shows only the
 * type-specific declarative fields. */
function stepRest(step: EncodedStep): Record<string, unknown> {
  const {
    key: _key,
    type: _type,
    on: _on,
    ...rest
  } = step as Record<string, unknown> & {
    key: unknown;
    type: unknown;
    on?: unknown;
  };
  return rest;
}

/** Render success/failure/blocked step routing targets, if any. */
function StepRoutingView({ routing }: { readonly routing: EncodedStepRouting | undefined }) {
  if (routing === undefined) {
    return null;
  }
  const entries = (["success", "failure", "blocked"] as const).filter(
    (k) => routing[k] !== undefined,
  );
  if (entries.length === 0) {
    return null;
  }
  return (
    <p className="text-xs text-foreground">
      <span className="font-mono opacity-70">on</span>
      {" · "}
      {entries.map((k, i) => (
        <span key={k}>
          {i > 0 ? ", " : ""}
          {k} → {String(routing[k])}
        </span>
      ))}
    </p>
  );
}

/**
 * Render the FULL executable semantics of a generated board so the human-review
 * gate is meaningful: for every lane we show its entry mode, terminal flag,
 * every pipeline step (including the complete agent instruction / approval
 * prompt), its transitions, human actions, and success/failure/blocked routing.
 *
 * Every model-authored string (instructions, prompts, names, transition JSON)
 * is rendered as escaped React text children — NEVER dangerouslySetInnerHTML.
 */
function DraftSummary({ definition }: { readonly definition: WorkflowDefinitionEncoded }) {
  const lanes = definition.lanes ?? [];
  const settings = definition.settings;
  const sources = definition.sources ?? [];
  const outbound = definition.outbound ?? [];
  if (lanes.length === 0) {
    return <p className="text-xs text-muted-foreground">No lanes in the generated board.</p>;
  }
  return (
    <>
      {/* ── Board-level settings ─────────────────────────────────────── */}
      {settings !== undefined ? (
        <div className="mb-2 rounded-md border border-border/70 bg-card/35 p-3 space-y-1">
          <p className="text-[11px] font-semibold text-foreground">Board settings</p>
          {(Object.keys(settings) as Array<keyof typeof settings>).map((k) => (
            <MetaRow key={String(k)} label={String(k)}>
              {String(settings[k])}
            </MetaRow>
          ))}
        </div>
      ) : null}

      {/* ── External sources ─────────────────────────────────────────── */}
      {sources.length > 0 ? (
        <div className="mb-2 rounded-md border border-warning/45 bg-warning/8 p-3 space-y-1">
          <p className="text-[11px] font-semibold text-foreground">
            External sources ({sources.length})
          </p>
          <p className="text-[11px] text-muted-foreground">
            These external systems will push tickets into this board.
          </p>
          <ul className="space-y-1">
            {sources.map((src, srcIndex) => (
              <li
                key={`${String(src.id)}-${srcIndex}`}
                className="rounded border border-border/50 bg-background/60 p-2 space-y-0.5"
              >
                <MetaRow label="id">{String(src.id)}</MetaRow>
                <MetaRow label="provider">{String(src.provider)}</MetaRow>
                <MetaRow label="connection">{String(src.connectionRef)}</MetaRow>
                <MetaRow label="destinationLane">{String(src.destinationLane)}</MetaRow>
                <MetaRow label="closedLane">{String(src.closedLane)}</MetaRow>
                {(() => {
                  const rule = effectiveAutoPullRule(src);
                  if (rule === null) {
                    return <MetaRow label="auto-pull">Manual only</MetaRow>;
                  }
                  const criteria = decodeAutoPullRule(rule);
                  const summary = criteria === null ? "advanced rule" : summarizeAutoPull(criteria);
                  return <MetaRow label="auto-pull">{summary}</MetaRow>;
                })()}
                {src.syncIntervalSec !== undefined ? (
                  <MetaRow label="syncIntervalSec">{String(src.syncIntervalSec)}</MetaRow>
                ) : null}
                <MetaRow label="selector">
                  <span className="font-mono break-words">{JSON.stringify(src.selector)}</span>
                </MetaRow>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── Outbound webhooks (security-relevant) ────────────────────── */}
      {outbound.length > 0 ? (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/8 p-3 space-y-1">
          <p className="text-[11px] font-semibold text-foreground">
            Outbound webhooks ({outbound.length})
          </p>
          <p className="text-[11px] text-muted-foreground">
            These rules send data to external URLs when board events occur — verify destinations
            before creating.
          </p>
          <ul className="space-y-1">
            {outbound.map((rule, ruleIndex) => (
              <li
                key={`${String(rule.id)}-${ruleIndex}`}
                className="rounded border border-border/50 bg-background/60 p-2 space-y-0.5"
              >
                <MetaRow label="id">{String(rule.id)}</MetaRow>
                <MetaRow label="trigger">{String(rule.on)}</MetaRow>
                <MetaRow label="destination">
                  <span className="font-mono break-words">{String(rule.to)}</span>
                </MetaRow>
                <MetaRow label="format">{String(rule.as)}</MetaRow>
                <MetaRow label="enabled">{String(rule.enabled)}</MetaRow>
                {rule.when !== undefined ? (
                  <MetaRow label="when">
                    <span className="font-mono break-words">{JSON.stringify(rule.when)}</span>
                  </MetaRow>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ol className="space-y-2">
        {lanes.map((lane, laneIndex) => {
          const pipeline = lane.pipeline ?? [];
          const transitions = lane.transitions ?? [];
          const actions = lane.actions ?? [];
          const laneOnEvent = lane.onEvent ?? [];
          const laneOn = lane.on;
          const laneOnEntries =
            laneOn === undefined
              ? []
              : (["success", "failure", "blocked"] as const).filter((k) => laneOn[k] !== undefined);
          return (
            <li
              key={`${String(lane.key)}-${laneIndex}`}
              className="rounded-md border border-border/70 bg-card/35 p-3"
            >
              <p className="text-sm font-medium text-foreground">{lane.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {String(lane.key)} · entry: {String(lane.entry)}
                {lane.terminal === true ? " · terminal" : ""}
              </p>

              {pipeline.length > 0 ? (
                <ul className="mt-1.5 space-y-1.5">
                  {pipeline.map((stepEntry, stepIndex) => (
                    <StepView key={`${String(stepEntry.key)}-${stepIndex}`} step={stepEntry} />
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">No pipeline steps.</p>
              )}

              {transitions.length > 0 ? (
                <div className="mt-2 space-y-0.5">
                  <p className="text-[11px] font-medium text-foreground">Transitions</p>
                  <ul className="space-y-0.5">
                    {transitions.map((transition, transitionIndex) => (
                      <li
                        key={`${String(transition.to)}-${transitionIndex}`}
                        className="text-xs text-foreground"
                      >
                        → {String(transition.to)}
                        {transition.when !== undefined ? (
                          <span className="font-mono opacity-70">
                            {" when "}
                            {JSON.stringify(transition.when)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {actions.length > 0 ? (
                <div className="mt-2 space-y-0.5">
                  <p className="text-[11px] font-medium text-foreground">Actions</p>
                  <ul className="space-y-0.5">
                    {actions.map((action, actionIndex) => (
                      <li
                        key={`${String(action.label)}-${actionIndex}`}
                        className="text-xs text-foreground"
                      >
                        {action.label} → {String(action.to)}
                        {action.hint !== undefined && action.hint.length > 0
                          ? ` (${action.hint})`
                          : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {laneOnEntries.length > 0 ? (
                <p className="mt-2 text-xs text-foreground">
                  <span className="font-mono opacity-70">routing</span>
                  {" · "}
                  {laneOnEntries.map((k, i) => (
                    <span key={k}>
                      {i > 0 ? ", " : ""}
                      {k} → {String(laneOn?.[k])}
                    </span>
                  ))}
                </p>
              ) : null}

              {laneOnEvent.length > 0 ? (
                <div className="mt-2 space-y-0.5">
                  <p className="text-[11px] font-medium text-foreground">On event</p>
                  <ul className="space-y-0.5">
                    {laneOnEvent.map((ev: EncodedOnEvent, evIndex: number) => (
                      <li key={`${String(ev.name)}-${evIndex}`} className="text-xs text-foreground">
                        <span className="font-mono">{String(ev.name)}</span>
                        {" → "}
                        {String(ev.to)}
                        {ev.when !== undefined ? (
                          <span className="font-mono opacity-70">
                            {" when "}
                            {JSON.stringify(ev.when)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
          Raw JSON
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-background p-2 text-[11px] text-foreground">
          {JSON.stringify(definition, null, 2)}
        </pre>
      </details>
    </>
  );
}
