import type {
  AgentSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";
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
import {
  approvedIntakeTickets,
  toIntakeDrafts,
  updateIntakeDraft,
  type ApprovedIntakeTicket,
  type IntakeProposalDraft,
  type IntakeTicketInput,
} from "~/workflow/intakeState";
import { resolveRecentAgent } from "~/workflow/resolveRecentAgent";

export function IntakeDialog({
  disabled,
  disabledReason,
  onCreateTickets,
  onPropose,
  open: controlledOpen,
  onOpenChange,
}: {
  readonly disabled: boolean;
  readonly disabledReason?: string | undefined;
  readonly onCreateTickets: (tickets: ReadonlyArray<ApprovedIntakeTicket>) => Promise<void>;
  readonly onPropose: (
    braindump: string,
    agent: AgentSelection,
  ) => Promise<ReadonlyArray<IntakeTicketInput>>;
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
  const [braindump, setBraindump] = useState("");
  const [proposing, setProposing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ReadonlyArray<IntakeProposalDraft> | null>(null);
  const [agent, setAgent] = useState<AgentSelection | null>(null);

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
  // The stored instance is a routing key; cast (not `.make`) so a non-slug
  // instance never throws while rendering.
  const activeInstanceId = (agent?.instance ?? "") as ProviderInstanceId;
  const selectedEntry = instanceEntries.find((entry) => entry.instanceId === activeInstanceId);

  const reset = () => {
    setBraindump("");
    setProposing(false);
    setCreating(false);
    setError(null);
    setDrafts(null);
  };

  const createApproved = async (tickets: ReadonlyArray<ApprovedIntakeTicket>) => {
    setCreating(true);
    setError(null);
    try {
      await onCreateTickets(tickets);
      reset();
      setOpen(false);
    } catch (cause) {
      // Keep the edited proposals on screen so nothing is lost on failure.
      setError(cause instanceof Error ? cause.message : "Creating tickets failed.");
      setCreating(false);
    }
  };

  const propose = async () => {
    const trimmed = braindump.trim();
    if (!trimmed || proposing || agent === null) {
      return;
    }
    setProposing(true);
    setError(null);
    try {
      const proposals = await onPropose(trimmed, agent);
      setDrafts(toIntakeDrafts(proposals));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ticket intake failed.");
    } finally {
      setProposing(false);
    }
  };

  const approved = drafts === null ? [] : approvedIntakeTickets(drafts);

  // In controlled mode the parent owns the trigger, so the default-agent
  // selection the self-contained trigger's onClick performed must fire when
  // the dialog transitions to open.
  useEffect(() => {
    if (isControlled && open) {
      setAgent((current) => current ?? resolveRecentAgent());
    }
  }, [isControlled, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          reset();
        }
      }}
    >
      {isControlled ? null : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled}
          title={disabled ? disabledReason : "Turn a braindump into tickets"}
          onClick={() => {
            setOpen(true);
            // Default to the user's most recent agent; they can change it below.
            setAgent((current) => current ?? resolveRecentAgent());
          }}
        >
          <SparklesIcon className="size-3.5" />
          Intake
        </Button>
      )}
      <DialogPopup className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-hidden">
        <div className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Ticket intake</DialogTitle>
            <DialogDescription>
              Paste everything on your mind. An agent reads the project and proposes tickets — you
              review and approve before anything is created.
            </DialogDescription>
          </DialogHeader>
          <div
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-1 pb-3"
            data-slot="dialog-panel"
          >
            {drafts === null ? (
              <>
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">Agent</span>
                  <div className="flex flex-wrap items-center gap-2" data-testid="intake-agent">
                    <ProviderModelPicker
                      activeInstanceId={activeInstanceId}
                      model={agent?.model ?? ""}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      triggerVariant="outline"
                      disabled={proposing}
                      onInstanceModelChange={(instanceId, model) => {
                        // Options survive a model switch — the effort picker
                        // only surfaces valid ones and providers ignore
                        // unknown option ids (same policy as agent steps).
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
                        disabled={proposing}
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
                <Textarea
                  value={braindump}
                  placeholder="Braindump: bugs you noticed, features you want, cleanups, anything…"
                  onChange={(event) => setBraindump(event.currentTarget.value)}
                  aria-label="Braindump"
                  rows={12}
                  autoFocus
                  disabled={proposing}
                />
              </>
            ) : (
              <ol className="space-y-3" data-testid="intake-proposals">
                {drafts.map((draft, index) => (
                  <li
                    key={index}
                    className="space-y-2 rounded-md border border-border/70 bg-card/35 p-3"
                  >
                    {draft.dependsOn.length > 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        After {draft.dependsOn.map((dependency) => `#${dependency + 1}`).join(", ")}
                      </p>
                    ) : null}
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={draft.include}
                        onChange={(event) => {
                          const include = event.currentTarget.checked;
                          setDrafts((current) =>
                            current === null
                              ? current
                              : updateIntakeDraft(current, index, { include }),
                          );
                        }}
                        aria-label={`Include proposal ${index + 1}`}
                      />
                      <Input
                        value={draft.title}
                        disabled={!draft.include}
                        onChange={(event) => {
                          const title = event.currentTarget.value;
                          setDrafts((current) =>
                            current === null
                              ? current
                              : updateIntakeDraft(current, index, { title }),
                          );
                        }}
                        aria-label={`Proposal ${index + 1} title`}
                      />
                    </div>
                    <Textarea
                      value={draft.description}
                      disabled={!draft.include}
                      rows={3}
                      onChange={(event) => {
                        const description = event.currentTarget.value;
                        setDrafts((current) =>
                          current === null
                            ? current
                            : updateIntakeDraft(current, index, { description }),
                        );
                      }}
                      aria-label={`Proposal ${index + 1} description`}
                    />
                  </li>
                ))}
              </ol>
            )}
            {error !== null ? (
              <p className="text-xs text-destructive-foreground" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {drafts === null ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    reset();
                    setOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!braindump.trim() || proposing || agent === null}
                  onClick={() => {
                    void propose();
                  }}
                >
                  {proposing ? "Proposing…" : "Propose tickets"}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" size="sm" onClick={() => setDrafts(null)}>
                  Back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={approved.length === 0 || creating}
                  onClick={() => {
                    void createApproved(approved);
                  }}
                >
                  {creating
                    ? "Creating…"
                    : `Create ${approved.length} ticket${approved.length === 1 ? "" : "s"}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
