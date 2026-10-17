import { useAtomSet } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type CivilizationContextInspectionCursor,
  type CivilizationContextInspectionDetail,
  type CivilizationContextInspectionOutcome,
  type CivilizationContextInspectionSummary,
  type EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import {
  civilizationSensitiveReadAction,
  type CivilizationContextInspectionFilters,
  useCivilizationContextInspectionPage,
} from "../../state/civilization";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSection } from "./settingsLayout";

interface CivilizationContextInspectorProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly targetLabel: string;
  readonly initialFilters?: CivilizationContextInspectionFilters | undefined;
}

type DraftFilters = {
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly outcome: CivilizationContextInspectionOutcome | "all";
  readonly runId: string;
  readonly attemptId: string;
  readonly providerTurnOrdinal: string;
};

const EMPTY_FILTERS: DraftFilters = {
  threadId: "",
  providerInstanceId: "",
  outcome: "all",
  runId: "",
  attemptId: "",
  providerTurnOrdinal: "",
};

const PAGE_SIZE = 25;

function draftFiltersFromApplied(filters: CivilizationContextInspectionFilters): DraftFilters {
  return {
    threadId: filters.threadId ?? "",
    providerInstanceId: filters.providerInstanceId ?? "",
    outcome: filters.outcome ?? "all",
    runId: filters.runId ?? "",
    attemptId: filters.attemptId ?? "",
    providerTurnOrdinal:
      filters.providerTurnOrdinal === undefined ? "" : String(filters.providerTurnOrdinal),
  };
}

const filtersIdentity = (filters: CivilizationContextInspectionFilters | undefined): string =>
  JSON.stringify(filters ?? {});

const outcomeLabel = (outcome: CivilizationContextInspectionOutcome): string => {
  switch (outcome) {
    case "skipped":
      return "Skipped";
    case "built":
      return "Built - provider start unresolved";
    case "provider_start_accepted":
      return "Provider start accepted";
    case "provider_start_failed":
      return "Provider start failed";
  }
};

const bodyUnavailableMessage = (detail: CivilizationContextInspectionDetail): string => {
  switch (detail.packetTextState) {
    case "pending_provider_start":
      return "Exact packet text is retained only after the provider start outcome is known.";
    case "diagnostics_off":
      return "Exact packet text was not retained because diagnostics were off for this turn.";
    case "errors_only_accepted_cleared":
      return "Exact packet text was cleared after the provider accepted the start because diagnostics were set to errors only.";
    case "skipped_no_packet":
      return "No packet was rendered for this skipped turn.";
    case "retained_error":
    case "retained_normal":
      return "Exact packet text is no longer available within the retained diagnostic record.";
  }
};

const formatDate = (value: string | null): string => {
  if (value === null) return "?";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};

const errorMessage = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "The historical Civilization context record could not be loaded.";
};

function appliedFilters(draft: DraftFilters): CivilizationContextInspectionFilters {
  const ordinal = Number(draft.providerTurnOrdinal);
  return {
    ...(draft.threadId.trim() === "" ? {} : { threadId: ThreadId.make(draft.threadId.trim()) }),
    ...(draft.providerInstanceId.trim() === ""
      ? {}
      : { providerInstanceId: ProviderInstanceId.make(draft.providerInstanceId.trim()) }),
    ...(draft.outcome === "all" ? {} : { outcome: draft.outcome }),
    ...(draft.runId.trim() === "" ? {} : { runId: RunId.make(draft.runId.trim()) }),
    ...(draft.attemptId.trim() === ""
      ? {}
      : { attemptId: RunAttemptId.make(draft.attemptId.trim()) }),
    ...(draft.providerTurnOrdinal.trim() === "" || !Number.isSafeInteger(ordinal) || ordinal < 1
      ? {}
      : { providerTurnOrdinal: ordinal }),
  };
}

function MetadataValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | number | null;
}) {
  return (
    <div className="min-w-0">
      <div className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="wrap-anywhere text-xs text-foreground">{value ?? "?"}</div>
    </div>
  );
}

function DetailDialog({
  open,
  onOpenChange,
  detail,
  loading,
  message,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly detail: CivilizationContextInspectionDetail | null;
  readonly loading: boolean;
  readonly message: string | null;
}) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const copyPacket = () => {
    if (detail?.packetText === null || detail?.packetText === undefined) return;
    void navigator.clipboard
      .writeText(detail.packetText)
      .then(() => setCopyMessage("Copied packet text."))
      .catch(() => setCopyMessage("Clipboard access failed."));
  };

  const downloadPacket = () => {
    if (detail?.packetText === null || detail?.packetText === undefined) return;
    const blob = new Blob([detail.packetText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `civilization-context-${detail.inspectionId}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Civilization historical context</DialogTitle>
          <DialogDescription>
            Exact host-side record for one provider-turn attempt. ?Provider start accepted? means T3
            handed the turn to the adapter successfully; it does not claim downstream model
            consumption.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading sensitive detail?</div>
          ) : null}
          {message === null ? null : <div className="text-sm text-destructive">{message}</div>}
          {detail === null ? null : (
            <div className="space-y-5">
              <section className="space-y-2">
                <h4 className="font-medium text-sm">Outcome</h4>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <MetadataValue label="Outcome" value={outcomeLabel(detail.outcome)} />
                  <MetadataValue label="Suppression" value={detail.suppressionReason} />
                  <MetadataValue
                    label="Provider start"
                    value={formatDate(detail.providerStartAt)}
                  />
                  <MetadataValue label="Transport" value={detail.transport?.kind ?? null} />
                  <MetadataValue label="Transport trust" value={detail.transport?.trust ?? null} />
                  <MetadataValue label="Diagnostics" value={detail.diagnosticsMode} />
                </div>
                {detail.transport === null ? null : (
                  <p className="text-xs text-muted-foreground">{detail.transport.description}</p>
                )}
              </section>

              <section className="space-y-2">
                <h4 className="font-medium text-sm">Composition</h4>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(["roster", "notes", "inbox"] as const).map((key) => {
                    const section = detail.composition[key];
                    return (
                      <div key={key} className="rounded-md border border-border/70 p-3 text-xs">
                        <div className="font-medium capitalize">{key}</div>
                        <div className="text-muted-foreground">
                          {section.included} included ? {section.omitted} omitted ?{" "}
                          {section.candidates} candidates
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="space-y-2">
                <h4 className="font-medium text-sm">Packet budget</h4>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <MetadataValue label="Limit" value={`${detail.budget.limitBytes} B`} />
                  <MetadataValue label="Packet" value={`${detail.budget.packetBytes} B`} />
                  <MetadataValue label="Required" value={`${detail.budget.requiredBytes} B`} />
                  <MetadataValue label="Roster" value={`${detail.budget.rosterBytes} B`} />
                  <MetadataValue label="Notes" value={`${detail.budget.noteBytes} B`} />
                  <MetadataValue label="Inbox" value={`${detail.budget.inboxBytes} B`} />
                  <MetadataValue label="Unused" value={`${detail.budget.unusedBytes} B`} />
                </div>
              </section>

              <section className="space-y-2">
                <h4 className="font-medium text-sm">Provenance</h4>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <MetadataValue label="Inspection" value={detail.inspectionId} />
                  <MetadataValue label="Context reference" value={detail.contextReferenceId} />
                  <MetadataValue label="Run" value={detail.runId} />
                  <MetadataValue label="Attempt" value={detail.attemptId} />
                  <MetadataValue label="Provider turn" value={detail.providerTurnOrdinal} />
                  <MetadataValue label="Packet hash" value={detail.packetHash} />
                  <MetadataValue label="Environment revision" value={detail.environmentRevision} />
                  <MetadataValue label="Project revision" value={detail.projectRevision} />
                  <MetadataValue label="Citizen revision" value={detail.citizenRevision} />
                  <MetadataValue label="Census revision" value={detail.censusRevision} />
                  <MetadataValue label="Notes revision" value={detail.notesRevision} />
                  <MetadataValue label="Inbox revision" value={detail.inboxRevision} />
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div className="wrap-anywhere">
                    Citizens: {detail.selectedCitizenIds.join(", ") || "none"}
                  </div>
                  <div className="wrap-anywhere">
                    Notes: {detail.selectedNoteIds.join(", ") || "none"}
                  </div>
                  <div className="wrap-anywhere">
                    Inbox: {detail.selectedInboxIds.join(", ") || "none"}
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium text-sm">Exact rendered packet</h4>
                  {detail.packetText === null ? null : (
                    <div className="flex gap-2">
                      <Button size="xs" variant="outline" onClick={copyPacket}>
                        Copy
                      </Button>
                      <Button size="xs" variant="outline" onClick={downloadPacket}>
                        Download text
                      </Button>
                    </div>
                  )}
                </div>
                {detail.packetText === null ? (
                  <div className="rounded-md border border-border/70 p-3 text-sm text-muted-foreground">
                    {bodyUnavailableMessage(detail)}
                  </div>
                ) : (
                  <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border border-border/70 bg-muted/30 p-3 font-mono text-xs">
                    {detail.packetText}
                  </pre>
                )}
                {copyMessage === null ? null : (
                  <div className="text-xs text-muted-foreground">{copyMessage}</div>
                )}
              </section>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function CivilizationContextInspector({
  environmentId,
  projectId,
  targetLabel,
  initialFilters,
}: CivilizationContextInspectorProps) {
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const readSensitive = useAtomSet(civilizationSensitiveReadAction, { mode: "promise" });
  const initialFiltersKey = filtersIdentity(initialFilters);
  const lastInitialFiltersKey = useRef(initialFiltersKey);
  const [draft, setDraft] = useState<DraftFilters>(() =>
    draftFiltersFromApplied(initialFilters ?? {}),
  );
  const [filters, setFilters] = useState<CivilizationContextInspectionFilters>(
    () => initialFilters ?? {},
  );
  const [cursor, setCursor] = useState<CivilizationContextInspectionCursor | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<CivilizationContextInspectionCursor | null>>(
    [],
  );
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<CivilizationContextInspectionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailMessage, setDetailMessage] = useState<string | null>(null);

  useEffect(() => {
    if (lastInitialFiltersKey.current === initialFiltersKey) return;
    lastInitialFiltersKey.current = initialFiltersKey;
    const next = initialFilters ?? {};
    setDraft(draftFiltersFromApplied(next));
    setFilters(next);
    setCursor(null);
    setCursorStack([]);
  }, [initialFilters, initialFiltersKey]);

  const page = useCivilizationContextInspectionPage(
    environmentId,
    projectId,
    filters,
    cursor,
    PAGE_SIZE,
  );

  const rows = page.data?.inspections ?? [];
  const nextCursor = page.data?.nextCursor ?? null;
  const hasPrevious = cursorStack.length > 0;
  const activeFilterCount = Object.values(filters).filter((value) => value !== undefined).length;

  const apply = () => {
    setFilters(appliedFilters(draft));
    setCursor(null);
    setCursorStack([]);
  };

  const reset = () => {
    setDraft(EMPTY_FILTERS);
    setFilters({});
    setCursor(null);
    setCursorStack([]);
  };

  const nextPage = () => {
    if (nextCursor === null) return;
    setCursorStack((current) => [...current, cursor]);
    setCursor(nextCursor);
  };

  const previousPage = () => {
    setCursorStack((current) => {
      if (current.length === 0) return current;
      setCursor(current.at(-1) ?? null);
      return current.slice(0, -1);
    });
  };

  const inspect = (summary: CivilizationContextInspectionSummary) => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setDetail(null);
      setDetailMessage("settings:write is required to load exact historical packet detail.");
      setDetailOpen(true);
      return;
    }
    setDetail(null);
    setDetailMessage(null);
    setDetailLoading(true);
    setDetailOpen(true);
    void readSensitive({
      type: "contextInspection",
      environmentId,
      projectId,
      inspectionId: summary.inspectionId,
    })
      .then((result) => {
        setDetailLoading(false);
        setDetail((result as CivilizationContextInspectionDetail | null) ?? null);
        if (result === null)
          setDetailMessage("This retained inspection record is no longer available.");
      })
      .catch((error: unknown) => {
        setDetailLoading(false);
        setDetailMessage(errorMessage(error));
      });
  };

  return (
    <SettingsSection title="Context inspector" id="civilization-context-inspector">
      <div className="space-y-4 px-1 py-2">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Historical provider-turn records for {targetLabel}. Metadata is read-only; exact packet
            text is fetched only when you inspect a row and requires settings:write.
          </p>
          <p className="text-xs text-muted-foreground">
            These are historical records. The agent-facing civilization_context tool remains a
            separate, non-mutating preview of current context.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Input
            aria-label="Context inspector thread ID"
            placeholder="Thread ID"
            value={draft.threadId}
            onChange={(event) =>
              setDraft((current) => ({ ...current, threadId: event.currentTarget.value }))
            }
          />
          <Input
            aria-label="Context inspector provider"
            placeholder="Provider instance ID"
            value={draft.providerInstanceId}
            onChange={(event) =>
              setDraft((current) => ({ ...current, providerInstanceId: event.currentTarget.value }))
            }
          />
          <Select
            value={draft.outcome}
            onValueChange={(value) =>
              setDraft((current) => ({ ...current, outcome: value as DraftFilters["outcome"] }))
            }
          >
            <SelectTrigger aria-label="Context inspector outcome">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All outcomes</SelectItem>
              <SelectItem value="skipped">Skipped</SelectItem>
              <SelectItem value="built">Built</SelectItem>
              <SelectItem value="provider_start_accepted">Provider start accepted</SelectItem>
              <SelectItem value="provider_start_failed">Provider start failed</SelectItem>
            </SelectPopup>
          </Select>
          <Input
            aria-label="Context inspector run ID"
            placeholder="Run ID"
            value={draft.runId}
            onChange={(event) =>
              setDraft((current) => ({ ...current, runId: event.currentTarget.value }))
            }
          />
          <Input
            aria-label="Context inspector attempt ID"
            placeholder="Attempt ID"
            value={draft.attemptId}
            onChange={(event) =>
              setDraft((current) => ({ ...current, attemptId: event.currentTarget.value }))
            }
          />
          <Input
            aria-label="Context inspector provider turn"
            inputMode="numeric"
            placeholder="Provider turn ordinal"
            value={draft.providerTurnOrdinal}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                providerTurnOrdinal: event.currentTarget.value,
              }))
            }
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={apply}>
            Apply filters
          </Button>
          <Button size="sm" variant="outline" onClick={reset}>
            Reset
          </Button>
          <span className="text-xs text-muted-foreground">{activeFilterCount} active filters</span>
        </div>

        {page.error === null ? null : (
          <div className="text-sm text-destructive">
            Historical context metadata could not be loaded.
          </div>
        )}
        {page.isPending && page.data === null ? (
          <div className="text-sm text-muted-foreground">Loading historical context metadata?</div>
        ) : null}
        {!page.isPending && page.data !== null && rows.length === 0 ? (
          <div className="rounded-md border border-border/70 p-3 text-sm text-muted-foreground">
            No retained context-inspection records match these filters.
          </div>
        ) : null}

        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.inspectionId} className="rounded-lg border border-border/70 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium">{outcomeLabel(row.outcome)}</span>
                    <span className="text-muted-foreground">{row.providerInstanceId}</span>
                    <span className="text-muted-foreground">{formatDate(row.createdAt)}</span>
                  </div>
                  <div className="wrap-anywhere text-xs text-muted-foreground">
                    thread {row.threadId} ? run {row.runId} ? attempt {row.attemptId} ? provider
                    turn {row.providerTurnOrdinal}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.packetBytes} B ? roster {row.composition.roster.included}/
                    {row.composition.roster.candidates} ? notes {row.composition.notes.included}/
                    {row.composition.notes.candidates} ? inbox {row.composition.inbox.included}/
                    {row.composition.inbox.candidates}
                  </div>
                  {row.suppressionReason === null ? null : (
                    <div className="text-xs text-muted-foreground">
                      suppressed: {row.suppressionReason}
                    </div>
                  )}
                </div>
                {canWrite ? (
                  <Button size="xs" variant="outline" onClick={() => inspect(row)}>
                    Inspect
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Detail requires settings:write
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="outline" disabled={!hasPrevious} onClick={previousPage}>
            Previous
          </Button>
          <Button size="sm" variant="outline" disabled={nextCursor === null} onClick={nextPage}>
            Next
          </Button>
        </div>
      </div>

      <DetailDialog
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) {
            setDetail(null);
            setDetailMessage(null);
            setDetailLoading(false);
          }
        }}
        detail={detail}
        loading={detailLoading}
        message={detailMessage}
      />
    </SettingsSection>
  );
}
