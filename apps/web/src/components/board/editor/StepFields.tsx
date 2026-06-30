import { LaneKey, type ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";
import { useMemo } from "react";

import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { usePrimarySettings } from "~/hooks/useSettings";
import { getAppModelOptionsForInstance, type AppModelOption } from "~/modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "~/providerInstances";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerProvidersAtom } from "~/state/server";
import { updateStep } from "~/workflow/editorModel";

import {
  agentSelectionWithInstanceModel,
  agentSelectionWithOptions,
  escalationWithOptions,
  retryWithEscalation,
  retryWithMaxAttempts,
  type StepRetryEncoded,
} from "./agentStepSelection";
import type {
  WorkflowEditorMutation,
  WorkflowLaneEncoded,
  WorkflowStepEncoded,
} from "./WorkflowEditor";

type RouteKind = "success" | "failure" | "blocked";
type InstructionMode = "inline" | "file";

export function StepFields({
  laneKey,
  lanes,
  step,
  disabled = false,
  onMutate,
}: {
  readonly laneKey: string;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly step: WorkflowStepEncoded;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const stepKey = String(step.key);

  return (
    <div className="space-y-3">
      {step.type === "agent" ? (
        <AgentStepFields
          laneKey={laneKey}
          lanes={lanes}
          step={step}
          disabled={disabled}
          onMutate={onMutate}
        />
      ) : null}
      {step.type === "script" ? (
        <ScriptStepFields laneKey={laneKey} step={step} disabled={disabled} onMutate={onMutate} />
      ) : null}
      {step.type === "approval" ? (
        <ApprovalStepFields laneKey={laneKey} step={step} disabled={disabled} onMutate={onMutate} />
      ) : null}
      {step.type === "merge" ? (
        <MergeStepFields laneKey={laneKey} step={step} disabled={disabled} onMutate={onMutate} />
      ) : null}
      {step.type === "pullRequest" ? (
        <PullRequestStepFields
          laneKey={laneKey}
          step={step}
          disabled={disabled}
          onMutate={onMutate}
        />
      ) : null}
      <div className="grid gap-3 @2xl:grid-cols-3">
        <StepRouteSelect
          label={`Step ${stepKey} success route`}
          lanes={lanes}
          value={step.on?.success}
          disabled={disabled}
          onChange={(targetLaneKey) =>
            updateRoute(onMutate, laneKey, step, "success", targetLaneKey)
          }
        />
        <StepRouteSelect
          label={`Step ${stepKey} failure route`}
          lanes={lanes}
          value={step.on?.failure}
          disabled={disabled}
          onChange={(targetLaneKey) =>
            updateRoute(onMutate, laneKey, step, "failure", targetLaneKey)
          }
        />
        <StepRouteSelect
          label={`Step ${stepKey} blocked route`}
          lanes={lanes}
          value={step.on?.blocked}
          disabled={disabled}
          onChange={(targetLaneKey) =>
            updateRoute(onMutate, laneKey, step, "blocked", targetLaneKey)
          }
        />
      </div>
    </div>
  );
}

function AgentStepFields({
  laneKey,
  lanes: _lanes,
  step,
  disabled = false,
  onMutate,
}: {
  readonly laneKey: string;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly step: Extract<WorkflowStepEncoded, { readonly type: "agent" }>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const stepKey = String(step.key);
  const isPanel = (step.panel ?? 0) >= 2;
  const instructionMode: InstructionMode = typeof step.instruction === "string" ? "inline" : "file";
  const instructionValue =
    typeof step.instruction === "string" ? step.instruction : step.instruction.file;

  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = usePrimarySettings();
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
  // The agent instance is only a `TrimmedNonEmptyString` in the workflow
  // contract, which is looser than the slug-validated `ProviderInstanceId`
  // brand. Treat the stored value as a routing key (cast, not `.make`) so a
  // board with a non-slug instance does not throw while rendering the editor.
  const activeInstanceId = step.agent.instance as ProviderInstanceId;
  const selectedEntry = instanceEntries.find((entry) => entry.instanceId === activeInstanceId);
  const selectedOptions = step.agent.options as ReadonlyArray<ProviderOptionSelection> | undefined;

  return (
    <div className="grid gap-3 @2xl:grid-cols-2">
      <div className="grid gap-3 @2xl:col-span-2 @2xl:grid-cols-[10rem_minmax(0,1fr)]">
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Instruction mode</span>
          <select
            aria-label={`Instruction source for step ${stepKey}`}
            className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={instructionMode}
            disabled={disabled}
            onChange={(event) => {
              const mode = event.currentTarget.value as InstructionMode;
              onMutate((current) =>
                updateStep(current, laneKey, stepKey, {
                  instruction: mode === "file" ? { file: instructionValue } : instructionValue,
                }),
              );
            }}
          >
            <option value="inline">Inline</option>
            <option value="file">File</option>
          </select>
        </label>
        {instructionMode === "file" ? (
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">
              Step {stepKey} instruction file
            </span>
            <Input
              aria-label={`Instruction file for step ${stepKey}`}
              value={instructionValue}
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value;
                onMutate((current) =>
                  updateStep(current, laneKey, stepKey, { instruction: { file: value } }),
                );
              }}
            />
          </label>
        ) : (
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Step {stepKey} instruction</span>
            <Textarea
              aria-label={`Step ${stepKey} instruction`}
              value={instructionValue}
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value;
                onMutate((current) =>
                  updateStep(current, laneKey, stepKey, { instruction: value }),
                );
              }}
            />
          </label>
        )}
        <p className="text-xs text-muted-foreground @2xl:col-span-2">
          Hand off a prior step&apos;s captured output with{" "}
          <code className="font-mono">{"{{prev.output}}"}</code> (the preceding step) or{" "}
          <code className="font-mono">{"{{step.<key>.output}}"}</code> (a named step, latest
          completed pass). Large outputs spill to a per-ticket scratch file that never reaches the
          PR.
        </p>
      </div>
      <div className="grid gap-1.5 @2xl:col-span-2">
        <span className="text-xs font-medium text-foreground">Agent</span>
        <div className="flex flex-wrap items-center gap-2">
          <ProviderModelPicker
            activeInstanceId={activeInstanceId}
            model={step.agent.model}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            triggerVariant="outline"
            disabled={disabled}
            onInstanceModelChange={(instanceId, model) => {
              onMutate((current) =>
                updateStep(current, laneKey, stepKey, {
                  agent: agentSelectionWithInstanceModel(step.agent, instanceId, model),
                }),
              );
            }}
          />
          {selectedEntry ? (
            <TraitsPicker
              provider={selectedEntry.driverKind}
              instanceId={selectedEntry.instanceId}
              models={selectedEntry.models}
              model={step.agent.model}
              modelOptions={selectedOptions}
              prompt=""
              onPromptChange={() => {}}
              allowPromptInjectedEffort={false}
              triggerVariant="outline"
              disabled={disabled}
              onModelOptionsChange={(nextOptions) => {
                onMutate((current) =>
                  updateStep(current, laneKey, stepKey, {
                    agent: agentSelectionWithOptions(step.agent, nextOptions),
                  }),
                );
              }}
            />
          ) : null}
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={step.captureOutput ?? false}
          disabled={disabled}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            onMutate((current) =>
              updateStep(current, laneKey, stepKey, {
                captureOutput: checked || undefined,
                // Panel requires captureOutput (lint) and its selector hides
                // with it — never strand a stale value the user cannot see.
                ...(checked ? {} : { panel: undefined }),
              }),
            );
          }}
        />
        Capture output
      </label>
      <label className="grid gap-1 text-sm text-foreground">
        <span className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label={`Continue session for step ${stepKey}`}
            checked={step.continueSession ?? false}
            // A reviewer panel fans out N independent turns, so resuming a single
            // shared session is ambiguous (lint also rejects it). Disable the
            // toggle and clear any stale value when the step becomes a panel.
            disabled={disabled || isPanel}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              onMutate((current) =>
                updateStep(current, laneKey, stepKey, {
                  continueSession: checked || undefined,
                }),
              );
            }}
          />
          Continue session
        </span>
        <span className="text-xs text-muted-foreground">
          Resume this agent&apos;s own provider session across the lane&apos;s steps and loops.
          Requires a resumable provider (Codex, Claude, Grok, or Cursor) — other providers are
          rejected when the board is validated.
        </span>
      </label>
      {step.captureOutput === true ? (
        <label className="grid gap-1.5 text-sm text-foreground">
          <span className="text-xs font-medium">Reviewers (majority verdict)</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:opacity-64"
            value={step.panel ?? ""}
            disabled={disabled}
            aria-label={`Reviewer panel for step ${stepKey}`}
            onChange={(event) => {
              const parsed = Number.parseInt(event.currentTarget.value, 10);
              const panel = Number.isFinite(parsed) && parsed >= 2 ? parsed : undefined;
              onMutate((current) =>
                updateStep(current, laneKey, stepKey, {
                  panel,
                  // A panel cannot resume a single shared session (lint rejects
                  // it); drop any stale flag the user can no longer toggle off.
                  ...(panel !== undefined ? { continueSession: undefined } : {}),
                }),
              );
            }}
          >
            <option value="">Single reviewer</option>
            {[2, 3, 4, 5].map((count) => (
              <option key={count} value={count}>
                {count} reviewers
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="grid gap-3 @2xl:col-span-2">
        <StepRetrySelect
          stepKey={stepKey}
          value={step.retry?.maxAttempts}
          disabled={disabled}
          onChange={(maxAttempts) =>
            onMutate((current) =>
              updateStep(current, laneKey, stepKey, {
                retry: retryWithMaxAttempts(step.retry, maxAttempts),
              }),
            )
          }
        />
        {step.retry !== undefined ? (
          <>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                aria-label={`Escalate on retry for step ${stepKey}`}
                checked={step.retry.escalate !== undefined}
                disabled={disabled}
                onChange={(event) => {
                  const retry = step.retry;
                  if (retry === undefined) {
                    return;
                  }
                  const checked = event.currentTarget.checked;
                  onMutate((current) =>
                    updateStep(current, laneKey, stepKey, {
                      retry: retryWithEscalation(
                        retry,
                        checked
                          ? { instance: step.agent.instance, model: step.agent.model }
                          : undefined,
                      ),
                    }),
                  );
                }}
              />
              Escalate on retry
            </label>
            {step.retry.escalate !== undefined ? (
              <EscalationPicker
                laneKey={laneKey}
                stepKey={stepKey}
                retry={step.retry}
                escalate={step.retry.escalate}
                disabled={disabled}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                onMutate={onMutate}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function EscalationPicker({
  laneKey,
  stepKey,
  retry,
  escalate,
  disabled,
  instanceEntries,
  modelOptionsByInstance,
  onMutate,
}: {
  readonly laneKey: string;
  readonly stepKey: string;
  readonly retry: StepRetryEncoded;
  readonly escalate: NonNullable<StepRetryEncoded["escalate"]>;
  readonly disabled: boolean;
  readonly instanceEntries: ReturnType<typeof sortProviderInstanceEntries>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const escalateInstanceId = (escalate.instance ?? "") as ProviderInstanceId;
  const escalateEntry = instanceEntries.find((entry) => entry.instanceId === escalateInstanceId);
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">Escalate to</span>
      <div className="flex flex-wrap items-center gap-2">
        <ProviderModelPicker
          activeInstanceId={escalateInstanceId}
          model={escalate.model ?? ""}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          triggerVariant="outline"
          disabled={disabled}
          onInstanceModelChange={(instanceId, model) => {
            onMutate((current) =>
              updateStep(current, laneKey, stepKey, {
                retry: retryWithEscalation(retry, { ...escalate, instance: instanceId, model }),
              }),
            );
          }}
        />
        {escalateEntry ? (
          <TraitsPicker
            provider={escalateEntry.driverKind}
            instanceId={escalateEntry.instanceId}
            models={escalateEntry.models}
            model={escalate.model ?? ""}
            modelOptions={escalate.options as ReadonlyArray<ProviderOptionSelection> | undefined}
            prompt=""
            onPromptChange={() => {}}
            allowPromptInjectedEffort={false}
            triggerVariant="outline"
            disabled={disabled}
            onModelOptionsChange={(nextOptions) => {
              onMutate((current) =>
                updateStep(current, laneKey, stepKey, {
                  retry: retryWithEscalation(retry, escalationWithOptions(escalate, nextOptions)),
                }),
              );
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function StepRetrySelect({
  stepKey,
  value,
  disabled,
  onChange,
}: {
  readonly stepKey: string;
  readonly value: number | undefined;
  readonly disabled: boolean;
  readonly onChange: (maxAttempts: number | undefined) => void;
}) {
  // Lint enforces 2..5, but the contract's `maxAttempts` is an unbounded Int, so
  // a board authored outside this editor can hold an out-of-range value (e.g. 7).
  // Render an extra option for that value so the select reflects what's stored
  // instead of going blank; selecting any listed option still snaps back to 2..5.
  const standardOptions = [2, 3, 4, 5];
  const showCustomOption = value !== undefined && !standardOptions.includes(value);
  return (
    <label className="grid gap-1.5 @2xl:max-w-60">
      <span className="text-xs font-medium text-foreground">Retries</span>
      <select
        aria-label={`Retries for step ${stepKey}`}
        className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
        value={value === undefined ? "" : String(value)}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          onChange(raw === "" ? undefined : Number(raw));
        }}
      >
        <option value="">Off</option>
        {standardOptions.map((count) => (
          <option key={count} value={count}>
            {count} attempts
          </option>
        ))}
        {showCustomOption ? <option value={value}>{value} attempts</option> : null}
      </select>
    </label>
  );
}

function ScriptStepFields({
  laneKey,
  step,
  disabled = false,
  onMutate,
}: {
  readonly laneKey: string;
  readonly step: Extract<WorkflowStepEncoded, { readonly type: "script" }>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const stepKey = String(step.key);
  return (
    <div className="grid gap-3 @2xl:grid-cols-2">
      <label className="grid gap-1.5 @2xl:col-span-2">
        <span className="text-xs font-medium text-foreground">Step {stepKey} command</span>
        <Textarea
          aria-label={`Step ${stepKey} command`}
          value={step.run}
          disabled={disabled}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onMutate((current) => updateStep(current, laneKey, stepKey, { run: value }));
          }}
        />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Timeout</span>
        <Input
          aria-label={`Step ${stepKey} timeout`}
          value={step.timeout ?? ""}
          placeholder="5 minutes"
          disabled={disabled}
          onChange={(event) => {
            const value = event.currentTarget.value.trim() || undefined;
            onMutate((current) =>
              updateStep(current, laneKey, stepKey, {
                timeout: value,
              }),
            );
          }}
        />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Working directory</span>
        <Input
          aria-label={`Step ${stepKey} cwd`}
          value={step.cwd ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const value = event.currentTarget.value.trim() || undefined;
            onMutate((current) =>
              updateStep(current, laneKey, stepKey, {
                cwd: value,
              }),
            );
          }}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={step.allowFailure ?? false}
          disabled={disabled}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            onMutate((current) =>
              updateStep(current, laneKey, stepKey, {
                allowFailure: checked || undefined,
              }),
            );
          }}
        />
        Allow failure
      </label>
      <StepRetrySelect
        stepKey={stepKey}
        value={step.retry?.maxAttempts}
        disabled={disabled}
        onChange={(maxAttempts) =>
          onMutate((current) =>
            updateStep(current, laneKey, stepKey, {
              retry: retryWithMaxAttempts(step.retry, maxAttempts),
            }),
          )
        }
      />
    </div>
  );
}

function ApprovalStepFields({
  laneKey,
  step,
  disabled = false,
  onMutate,
}: {
  readonly laneKey: string;
  readonly step: Extract<WorkflowStepEncoded, { readonly type: "approval" }>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const stepKey = String(step.key);
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">Step {stepKey} prompt</span>
      <Textarea
        aria-label={`Step ${stepKey} prompt`}
        value={step.prompt ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const value = event.currentTarget.value || undefined;
          onMutate((current) =>
            updateStep(current, laneKey, stepKey, {
              prompt: value,
            }),
          );
        }}
      />
    </label>
  );
}

function MergeStepFields({
  laneKey,
  step,
  disabled = false,
  onMutate,
}: {
  readonly laneKey: string;
  readonly step: Extract<WorkflowStepEncoded, { readonly type: "merge" }>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const stepKey = String(step.key);
  return (
    <div className="grid gap-3 @2xl:grid-cols-2">
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Target branch</span>
        <Input
          aria-label={`Step ${stepKey} target branch`}
          value={step.target ?? ""}
          placeholder="Checked-out branch"
          disabled={disabled}
          onChange={(event) => {
            const value = event.currentTarget.value.trim() || undefined;
            onMutate((current) => updateStep(current, laneKey, stepKey, { target: value }));
          }}
        />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Commit message</span>
        <Input
          aria-label={`Step ${stepKey} commit message`}
          value={step.commitMessage ?? ""}
          placeholder="Ticket title (id)"
          disabled={disabled}
          onChange={(event) => {
            const value = event.currentTarget.value || undefined;
            onMutate((current) => updateStep(current, laneKey, stepKey, { commitMessage: value }));
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground @2xl:col-span-2">
        Commits the ticket worktree&apos;s outstanding work, then merges it into the branch checked
        out at the repo root. Conflicts or a dirty repo block the ticket instead of failing it.
      </p>
    </div>
  );
}

function PullRequestStepFields({
  laneKey,
  step,
  disabled = false,
  onMutate,
}: {
  readonly laneKey: string;
  readonly step: Extract<WorkflowStepEncoded, { readonly type: "pullRequest" }>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const stepKey = String(step.key);
  return (
    <div className="grid gap-3 @2xl:grid-cols-2">
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Action</span>
        <select
          aria-label={`Step ${stepKey} action`}
          className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={step.action}
          disabled={disabled}
          onChange={(event) => {
            const action = event.currentTarget.value as "open" | "land";
            onMutate((current) => updateStep(current, laneKey, stepKey, { action }));
          }}
        >
          <option value="open">Open pull request</option>
          <option value="land">Land pull request</option>
        </select>
      </label>
      {step.action === "open" ? (
        <>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Base branch</span>
            <Input
              aria-label={`Step ${stepKey} base branch`}
              value={step.base ?? ""}
              placeholder="Default branch"
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value.trim() || undefined;
                onMutate((current) => updateStep(current, laneKey, stepKey, { base: value }));
              }}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">PR title template</span>
            <Input
              aria-label={`Step ${stepKey} title template`}
              value={step.titleTemplate ?? ""}
              placeholder="{{ticket.title}}"
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value.trim() || undefined;
                onMutate((current) =>
                  updateStep(current, laneKey, stepKey, { titleTemplate: value }),
                );
              }}
            />
          </label>
          <label className="grid gap-1.5 @2xl:col-span-2">
            <span className="text-xs font-medium text-foreground">PR body template</span>
            <Textarea
              aria-label={`Step ${stepKey} body template`}
              value={step.bodyTemplate ?? ""}
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value || undefined;
                onMutate((current) =>
                  updateStep(current, laneKey, stepKey, { bodyTemplate: value }),
                );
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground @2xl:col-span-2">
            <input
              type="checkbox"
              aria-label={`Step ${stepKey} draft`}
              checked={step.draft ?? false}
              disabled={disabled}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                onMutate((current) =>
                  updateStep(current, laneKey, stepKey, { draft: checked || undefined }),
                );
              }}
            />
            Draft pull request
          </label>
          <p className="text-xs text-muted-foreground @2xl:col-span-2">
            Pushes the ticket&apos;s branch and opens a pull request. Conflicts or missing remotes
            block the ticket instead of failing it.
          </p>
        </>
      ) : null}
      {step.action === "land" ? (
        <>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Merge strategy</span>
            <select
              aria-label={`Step ${stepKey} merge strategy`}
              className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={step.strategy ?? ""}
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value || undefined;
                onMutate((current) =>
                  updateStep(current, laneKey, stepKey, {
                    strategy: value as "squash" | "merge" | "rebase" | undefined,
                  }),
                );
              }}
            >
              <option value="">Default</option>
              <option value="squash">Squash</option>
              <option value="merge">Merge</option>
              <option value="rebase">Rebase</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              aria-label={`Step ${stepKey} delete branch`}
              checked={step.deleteBranch !== false}
              disabled={disabled}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                onMutate((current) =>
                  updateStep(current, laneKey, stepKey, {
                    deleteBranch: checked ? undefined : false,
                  }),
                );
              }}
            />
            Delete branch after merge
          </label>
          <p className="text-xs text-muted-foreground @2xl:col-span-2">
            Lands the ticket&apos;s PR via <code className="font-mono">gh pr merge</code>; red
            checks or conflicts block the ticket instead of failing it.
          </p>
        </>
      ) : null}
    </div>
  );
}

function StepRouteSelect({
  label,
  lanes,
  value,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly value: string | undefined;
  readonly disabled?: boolean;
  readonly onChange: (targetLaneKey: string | undefined) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <select
        aria-label={label}
        className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const targetLaneKey = event.currentTarget.value || undefined;
          onChange(targetLaneKey);
        }}
      >
        <option value="">No route</option>
        {lanes.map((lane) => (
          <option key={String(lane.key)} value={String(lane.key)}>
            {lane.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function updateRoute(
  onMutate: WorkflowEditorMutation,
  laneKey: string,
  step: WorkflowStepEncoded,
  kind: RouteKind,
  targetLaneKey: string | undefined,
) {
  const nextOn = {
    ...step.on,
    [kind]: targetLaneKey === undefined ? undefined : LaneKey.make(targetLaneKey),
  };
  for (const key of ["success", "failure", "blocked"] as const) {
    if (nextOn[key] === undefined) {
      delete nextOn[key];
    }
  }
  onMutate((current) =>
    updateStep(current, laneKey, String(step.key), {
      on: Object.keys(nextOn).length === 0 ? undefined : nextOn,
    }),
  );
}
