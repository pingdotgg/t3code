import type {
  AgentSelection,
  EnvironmentApi,
  ProviderInstanceId,
  ProviderOptionSelection,
  WorkflowBoardProposalView,
  WorkflowDefinitionEncoded,
  WorkflowDryRunScenario,
  WorkflowLintError,
} from "@t3tools/contracts";
import { BoardId, LaneKey } from "@t3tools/contracts";
import { CheckCircleIcon, CircleSlash2Icon, WandSparklesIcon, XCircleIcon } from "lucide-react";
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
import { usePrimarySettings } from "~/hooks/useSettings";
import { getAppModelOptionsForInstance, type AppModelOption } from "~/modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "~/providerInstances";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerProvidersAtom } from "~/state/server";
import {
  getBoardProposal,
  listBoardProposals,
  proposeBoardImprovement,
  resolveBoardProposal,
  revertBoardProposal,
} from "~/workflow/boardRpc";
import { resolveRecentAgent } from "~/workflow/resolveRecentAgent";

import { DiffView } from "./editor/history/DiffView";
import { DryRunPanel } from "./editor/DryRunPanel";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusLabel(status: WorkflowBoardProposalView["status"]): string {
  switch (status) {
    case "pending":
      return "Pending review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "reverted":
      return "Reverted";
    case "superseded":
      return "Superseded";
    case "invalid":
      return "Invalid";
  }
}

function statusColor(status: WorkflowBoardProposalView["status"]): string {
  switch (status) {
    case "pending":
      return "text-foreground";
    case "approved":
      return "text-success-foreground";
    case "rejected":
    case "invalid":
      return "text-destructive";
    case "reverted":
    case "superseded":
      return "text-muted-foreground";
  }
}

// ─── Validation summary ───────────────────────────────────────────────────────

function ValidationSummary({
  validation,
}: {
  readonly validation: WorkflowBoardProposalView["validation"];
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3 text-xs">
        <CheckRow ok={validation.preservationOk} label="Lane preservation" />
        <CheckRow ok={validation.lintOk} label="Lint" />
        <CheckRow ok={validation.dryRunOk} label="Dry-run" />
        {validation.laneDiffCount > 0 ? (
          <span className="text-muted-foreground">
            {validation.laneDiffCount} lane{validation.laneDiffCount === 1 ? "" : "s"} changed
          </span>
        ) : null}
      </div>

      {validation.messages.length > 0 ? (
        <ul className="space-y-0.5 rounded-md border border-warning/45 bg-warning/8 p-2 text-xs text-warning-foreground">
          {validation.messages.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      ) : null}

      {validation.lintErrors.length > 0 ? (
        <LintErrorList lintErrors={validation.lintErrors} />
      ) : null}

      {validation.dryRunRegressions.length > 0 ? (
        <ul className="space-y-0.5 rounded-md border border-destructive/30 bg-destructive/8 p-2 text-xs text-destructive">
          <li className="font-medium">Dry-run regressions:</li>
          {validation.dryRunRegressions.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CheckRow({ ok, label }: { readonly ok: boolean; readonly label: string }) {
  return (
    <span
      className={`flex items-center gap-1 ${ok ? "text-success-foreground" : "text-destructive"}`}
    >
      {ok ? <CheckCircleIcon className="size-3.5" /> : <XCircleIcon className="size-3.5" />}
      {label}
    </span>
  );
}

function LintErrorList({ lintErrors }: { readonly lintErrors: ReadonlyArray<WorkflowLintError> }) {
  return (
    <ul className="rounded-md border border-warning/45 bg-warning/8 p-2 text-xs text-warning-foreground">
      {lintErrors.map((e, i) => (
        <li key={i}>{e.message}</li>
      ))}
    </ul>
  );
}

// ─── Proposal row in the list ─────────────────────────────────────────────────

function ProposalRow({
  proposal,
  selected,
  onSelect,
}: {
  readonly proposal: WorkflowBoardProposalView;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border p-3 text-left transition-colors hover:bg-muted/30 ${
        selected ? "border-border bg-muted/20" : "border-border/60 bg-card/30"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={`text-xs font-medium ${statusColor(proposal.status)}`}>
          {statusLabel(proposal.status)}
          {proposal.outdated ? (
            <span className="ml-1.5 rounded bg-warning/15 px-1 py-0.5 text-[10px] font-normal text-warning-foreground">
              outdated
            </span>
          ) : null}
        </span>
        <span className="text-[11px] text-muted-foreground">{formatDate(proposal.createdAt)}</span>
      </div>
      {proposal.rationale ? (
        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{proposal.rationale}</p>
      ) : null}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type Step = "generate" | "review" | "list";

export function SelfImproveDialog({
  boardId,
  disabled,
  api,
  open: controlledOpen,
  onOpenChange,
}: {
  readonly boardId: string | null;
  readonly disabled: boolean;
  readonly api: EnvironmentApi | null | undefined;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const isControlled = onOpenChange !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? (controlledOpen ?? false) : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (isControlled) {
      onOpenChange(next);
    } else {
      setUncontrolledOpen(next);
    }
  };
  const [step, setStep] = useState<Step>("generate");
  const [agent, setAgent] = useState<AgentSelection | null>(null);

  // Generate step state
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Review step state
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<WorkflowBoardProposalView | null>(null);
  const [proposedDefinition, setProposedDefinition] = useState<WorkflowDefinitionEncoded | null>(
    null,
  );
  const [baseDefinition, setBaseDefinition] = useState<WorkflowDefinitionEncoded | null>(null);
  const [loadingProposal, setLoadingProposal] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [dryRunOpen, setDryRunOpen] = useState(false);

  // List step state
  const [proposals, setProposals] = useState<ReadonlyArray<WorkflowBoardProposalView> | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedListProposalId, setSelectedListProposalId] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  // Provider/model picker state (mirrored from IntakeDialog)
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

  const activeInstanceId = (agent?.instance ?? "") as ProviderInstanceId;
  const selectedEntry = instanceEntries.find((e) => e.instanceId === activeInstanceId);

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const resetAll = () => {
    setStep("generate");
    setGenerating(false);
    setGenerateError(null);
    setProposalId(null);
    setProposal(null);
    setProposedDefinition(null);
    setBaseDefinition(null);
    setLoadingProposal(false);
    setReviewError(null);
    setResolving(false);
    setDryRunOpen(false);
    setProposals(null);
    setLoadingList(false);
    setListError(null);
    setSelectedListProposalId(null);
    setRevertingId(null);
    setRevertError(null);
  };

  const loadProposal = async (pid: string) => {
    if (!api) return;
    setLoadingProposal(true);
    setReviewError(null);
    try {
      const result = await getBoardProposal(api, pid);
      setProposal(result.proposal);
      setProposedDefinition(result.proposedDefinition);
      setBaseDefinition(result.baseDefinition);
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : "Failed to load proposal.");
    } finally {
      setLoadingProposal(false);
    }
  };

  const loadProposalList = async () => {
    if (!api || !boardId) return;
    setLoadingList(true);
    setListError(null);
    try {
      const result = await listBoardProposals(api, BoardId.make(boardId));
      // pending first, then by createdAt descending
      const sorted = [...result.proposals].sort((a, b) => {
        if (a.status === "pending" && b.status !== "pending") return -1;
        if (b.status === "pending" && a.status !== "pending") return 1;
        return b.createdAt.localeCompare(a.createdAt);
      });
      setProposals(sorted);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Failed to load proposals.");
    } finally {
      setLoadingList(false);
    }
  };

  // ─── Generate ─────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!api || !boardId || !agent || generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await proposeBoardImprovement(api, {
        boardId: BoardId.make(boardId),
        agent,
      });
      const newProposal = result.proposal;
      setProposalId(newProposal.proposalId);
      setProposal(newProposal);

      if (newProposal.status === "invalid") {
        // Stay on generate step but show the invalidity inline
        setGenerateError(null); // clear any prior RPC error
      } else {
        // Go to review and fetch full detail (with defs)
        setStep("review");
        await loadProposal(newProposal.proposalId);
      }
    } catch (cause) {
      setGenerateError(cause instanceof Error ? cause.message : "Failed to generate proposal.");
    } finally {
      setGenerating(false);
    }
  };

  // ─── Approve / Reject ─────────────────────────────────────────────────────

  const handleResolve = async (action: "approve" | "reject") => {
    if (!api || !proposalId || resolving) return;
    setResolving(true);
    setReviewError(null);
    try {
      const result = await resolveBoardProposal(api, { proposalId, action });
      if (
        result.ok &&
        result.proposal.status === (action === "approve" ? "approved" : "rejected")
      ) {
        setProposal(result.proposal);
        // Close only on a genuine approved transition; stay to show status on reject
        if (action === "approve") {
          resetAll();
          setOpen(false);
        }
      } else if (result.ok) {
        // ok:true but status didn't land on the expected value — treat as non-success:
        // refresh the proposal so the dialog reflects the real current state
        setProposal(result.proposal);
        setReviewError(
          "Unexpected proposal state after action — please review the current status.",
        );
      } else {
        // {ok:false} — do not close; show the reason and re-fetch so the dialog
        // reflects the server-side status (e.g. now superseded/invalid) and
        // disables Approve rather than letting a second click re-fire
        const reasonMsg =
          result.reason === "conflict"
            ? "The board changed while this proposal was open — re-generate to get a fresh one."
            : result.message;
        setReviewError(reasonMsg);
        // Re-fetch proposal to surface the updated status (superseded, invalid, etc.)
        if (proposalId) {
          await loadProposal(proposalId);
        }
      }
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : "Action failed.");
    } finally {
      setResolving(false);
    }
  };

  // ─── Revert ───────────────────────────────────────────────────────────────

  const handleRevert = async (pid: string) => {
    if (!api || revertingId !== null) return;
    setRevertingId(pid);
    setRevertError(null);
    try {
      const result = await revertBoardProposal(api, pid);
      if (result.ok && result.proposal.status === "reverted") {
        // Refresh list to show new status
        await loadProposalList();
        // Refresh selected proposal view if we have it open
        if (selectedListProposalId === pid) {
          await loadProposal(pid);
        }
      } else if (result.ok) {
        // ok:true but status didn't land on "reverted" — refresh to surface real state
        setRevertError(
          "Unexpected proposal state after revert — please review the current status.",
        );
        await loadProposalList();
        if (selectedListProposalId === pid) {
          await loadProposal(pid);
        }
      } else {
        // {ok:false} — keep dialog open, show reason, and re-fetch so the selected
        // proposal view reflects the server-side status (e.g. conflict, already reverted)
        const reasonMsg =
          result.reason === "conflict"
            ? "The board changed — re-run the revert after reviewing the latest definition."
            : result.message;
        setRevertError(reasonMsg);
        // Re-fetch list and selected proposal to surface the updated status
        await loadProposalList();
        if (selectedListProposalId === pid) {
          await loadProposal(pid);
        }
      }
    } catch (cause) {
      setRevertError(cause instanceof Error ? cause.message : "Revert failed.");
    } finally {
      setRevertingId(null);
    }
  };

  // ─── Open ─────────────────────────────────────────────────────────────────

  const handleOpen = () => {
    setOpen(true);
    setAgent((current) => current ?? resolveRecentAgent());
  };

  // In controlled mode the parent owns the trigger, so the default-agent
  // selection handleOpen performed must fire when the dialog transitions open.
  useEffect(() => {
    if (isControlled && open) {
      setAgent((current) => current ?? resolveRecentAgent());
    }
  }, [isControlled, open]);

  // ─── Render ───────────────────────────────────────────────────────────────

  const isApprovable = proposal !== null && proposal.status === "pending" && !proposal.outdated;

  const invalidProposal = proposal !== null && proposal.status === "invalid" ? proposal : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          resetAll();
        }
      }}
    >
      {isControlled ? null : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled || !boardId}
          title={disabled ? "No board selected" : "Suggest AI improvements to this board"}
          onClick={handleOpen}
        >
          <WandSparklesIcon className="size-3.5" />
          Suggest improvements
        </Button>
      )}
      <DialogPopup className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-hidden">
        <div className="flex min-h-0 flex-col">
          {/* ── Generate step ──────────────────────────────────────────── */}
          {step === "generate" ? (
            <>
              <DialogHeader>
                <DialogTitle>Suggest board improvements</DialogTitle>
                <DialogDescription>
                  An AI agent reviews this board&apos;s workflow definition and proposes targeted
                  improvements. You&apos;ll review and approve before anything changes.
                </DialogDescription>
              </DialogHeader>
              <div
                className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-1 pb-3"
                data-slot="dialog-panel"
              >
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">Agent</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <ProviderModelPicker
                      activeInstanceId={activeInstanceId}
                      model={agent?.model ?? ""}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      triggerVariant="outline"
                      disabled={generating}
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
                        modelOptions={
                          agent.options as ReadonlyArray<ProviderOptionSelection> | undefined
                        }
                        prompt=""
                        onPromptChange={() => {}}
                        allowPromptInjectedEffort={false}
                        triggerVariant="outline"
                        disabled={generating}
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
                      <span className="text-xs text-muted-foreground">
                        No agent provider available.
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Invalid proposal returned (shown inline on generate step) */}
                {invalidProposal !== null ? (
                  <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/8 p-3">
                    <p className="text-xs font-medium text-destructive">
                      The generated proposal was invalid and cannot be approved.
                    </p>
                    {invalidProposal.rationale ? (
                      <p className="text-xs text-muted-foreground">{invalidProposal.rationale}</p>
                    ) : null}
                    <ValidationSummary validation={invalidProposal.validation} />
                  </div>
                ) : null}

                {generateError !== null ? (
                  <p className="text-xs text-destructive-foreground" role="alert">
                    {generateError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setStep("list");
                    void loadProposalList();
                  }}
                >
                  View past proposals
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    resetAll();
                    setOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={agent === null || generating}
                  onClick={() => void handleGenerate()}
                >
                  {generating
                    ? "Generating…"
                    : invalidProposal !== null
                      ? "Re-generate"
                      : "Generate"}
                </Button>
              </DialogFooter>
            </>
          ) : null}

          {/* ── Review step ────────────────────────────────────────────── */}
          {step === "review" ? (
            <>
              <DialogHeader>
                <DialogTitle>Review proposal</DialogTitle>
                <DialogDescription>
                  Inspect the suggested changes and approve or reject them.
                </DialogDescription>
              </DialogHeader>

              {/* Dry-run panel sits above scrollable body when open */}
              {dryRunOpen && proposedDefinition && api ? (
                <DryRunPanel
                  definition={proposedDefinition}
                  onDryRun={(input) =>
                    api.workflow.dryRunBoard({
                      definition: proposedDefinition,
                      startLane: LaneKey.make(input.startLane),
                      scenario: input.scenario as WorkflowDryRunScenario,
                    })
                  }
                  onClose={() => setDryRunOpen(false)}
                />
              ) : null}

              <div
                className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-1 pb-3"
                data-slot="dialog-panel"
              >
                {loadingProposal ? (
                  <p className="text-xs text-muted-foreground">Loading proposal…</p>
                ) : null}

                {proposal !== null && !loadingProposal ? (
                  <>
                    {/* Status badge */}
                    {proposal.status !== "pending" ? (
                      <p className={`text-xs font-medium ${statusColor(proposal.status)}`}>
                        {statusLabel(proposal.status)}
                        {proposal.outdated ? (
                          <span className="ml-2 rounded bg-warning/15 px-1 py-0.5 text-[10px] font-normal text-warning-foreground">
                            outdated
                          </span>
                        ) : null}
                      </p>
                    ) : null}

                    {/* Rationale */}
                    {proposal.rationale ? (
                      <div className="space-y-1">
                        <span className="text-xs font-medium text-foreground">Rationale</span>
                        <p className="text-xs text-muted-foreground">{proposal.rationale}</p>
                      </div>
                    ) : null}

                    {/* Validation */}
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-foreground">Validation</span>
                      <ValidationSummary validation={proposal.validation} />
                    </div>

                    {/* Diff */}
                    {baseDefinition && proposedDefinition ? (
                      <div className="space-y-1">
                        <span className="text-xs font-medium text-foreground">Changes</span>
                        <DiffView
                          currentDefinition={proposedDefinition}
                          versionDefinition={baseDefinition}
                        />
                      </div>
                    ) : null}

                    {/* Simulate toggle */}
                    {proposedDefinition && !dryRunOpen ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setDryRunOpen(true)}
                      >
                        Simulate proposed workflow
                      </Button>
                    ) : null}
                  </>
                ) : null}

                {reviewError !== null ? (
                  <p className="text-xs text-destructive-foreground" role="alert">
                    {reviewError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setStep("generate");
                    setProposal(null);
                    setProposedDefinition(null);
                    setBaseDefinition(null);
                    setReviewError(null);
                    setDryRunOpen(false);
                  }}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={resolving || loadingProposal}
                  onClick={() => void handleResolve("reject")}
                >
                  {resolving ? "Working…" : "Reject"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!isApprovable || resolving || loadingProposal}
                  title={
                    proposal?.outdated
                      ? "Proposal is outdated — re-generate to get a fresh one"
                      : proposal?.status !== "pending"
                        ? `Proposal is ${proposal?.status ?? "not pending"}`
                        : undefined
                  }
                  onClick={() => void handleResolve("approve")}
                >
                  {resolving ? "Working…" : "Approve"}
                </Button>
              </DialogFooter>
            </>
          ) : null}

          {/* ── List step ──────────────────────────────────────────────── */}
          {step === "list" ? (
            <>
              <DialogHeader>
                <DialogTitle>Past proposals</DialogTitle>
                <DialogDescription>
                  Recent improvement proposals for this board. Select one to view or revert.
                </DialogDescription>
              </DialogHeader>
              <div
                className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pt-1 pb-3"
                data-slot="dialog-panel"
              >
                {loadingList ? (
                  <p className="text-xs text-muted-foreground">Loading proposals…</p>
                ) : null}

                {!loadingList && listError !== null ? (
                  <p className="text-xs text-destructive-foreground" role="alert">
                    {listError}
                  </p>
                ) : null}

                {!loadingList && proposals !== null && proposals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No proposals yet.</p>
                ) : null}

                {proposals !== null && proposals.length > 0 ? (
                  <div className="space-y-2">
                    {proposals.map((p) => (
                      <div key={p.proposalId} className="space-y-1">
                        <ProposalRow
                          proposal={p}
                          selected={selectedListProposalId === p.proposalId}
                          onSelect={() => {
                            if (selectedListProposalId === p.proposalId) {
                              setSelectedListProposalId(null);
                            } else {
                              setSelectedListProposalId(p.proposalId);
                              void (async () => {
                                setLoadingProposal(true);
                                setReviewError(null);
                                try {
                                  const result = await getBoardProposal(api!, p.proposalId);
                                  setProposal(result.proposal);
                                  setProposedDefinition(result.proposedDefinition);
                                  setBaseDefinition(result.baseDefinition);
                                } catch (cause) {
                                  setReviewError(
                                    cause instanceof Error
                                      ? cause.message
                                      : "Failed to load proposal.",
                                  );
                                } finally {
                                  setLoadingProposal(false);
                                }
                              })();
                            }
                          }}
                        />

                        {selectedListProposalId === p.proposalId ? (
                          <div className="space-y-3 rounded-md border border-border/60 bg-card/20 px-3 py-2">
                            {loadingProposal ? (
                              <p className="text-xs text-muted-foreground">Loading…</p>
                            ) : null}

                            {!loadingProposal &&
                            proposal !== null &&
                            proposal.proposalId === p.proposalId ? (
                              <>
                                {proposal.rationale ? (
                                  <div className="space-y-0.5">
                                    <span className="text-xs font-medium text-foreground">
                                      Rationale
                                    </span>
                                    <p className="text-xs text-muted-foreground">
                                      {proposal.rationale}
                                    </p>
                                  </div>
                                ) : null}
                                <ValidationSummary validation={proposal.validation} />
                                {baseDefinition && proposedDefinition ? (
                                  <DiffView
                                    currentDefinition={proposedDefinition}
                                    versionDefinition={baseDefinition}
                                  />
                                ) : null}
                                {p.status === "approved" ? (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={revertingId !== null}
                                    onClick={() => void handleRevert(p.proposalId)}
                                  >
                                    <CircleSlash2Icon className="size-3.5" />
                                    {revertingId === p.proposalId
                                      ? "Reverting…"
                                      : "Revert this improvement"}
                                  </Button>
                                ) : null}
                              </>
                            ) : null}

                            {reviewError !== null ? (
                              <p className="text-xs text-destructive-foreground" role="alert">
                                {reviewError}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {revertError !== null ? (
                  <p className="text-xs text-destructive-foreground" role="alert">
                    {revertError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setStep("generate");
                    setProposals(null);
                    setSelectedListProposalId(null);
                    setProposal(null);
                    setProposedDefinition(null);
                    setBaseDefinition(null);
                    setReviewError(null);
                    setRevertError(null);
                  }}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setStep("generate");
                    setProposals(null);
                    setSelectedListProposalId(null);
                    setProposal(null);
                    setProposedDefinition(null);
                    setBaseDefinition(null);
                    setReviewError(null);
                    setRevertError(null);
                  }}
                >
                  New proposal
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
