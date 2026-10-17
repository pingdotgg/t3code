import { useAtomSet } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type CivilizationAdminMailRecord,
  type CivilizationCensusCursor,
  type CivilizationCensusPage,
  type CivilizationCitizenReassignmentPreview,
  type CivilizationCitizenReassignmentRequest,
  type CivilizationCitizenSummary,
  type CivilizationEffectiveConfig,
  type CivilizationAdminMailPage,
  type CivilizationInboxCursor,
  type CivilizationMailSummary,
  type CivilizationNoteBody,
  type CivilizationNoteSummary,
  type CivilizationNotesCursor,
  type CivilizationNotesPage,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  civilizationCitizenAction,
  civilizationProjectReadAction,
  civilizationSensitiveReadAction,
  mergeCivilizationRevisionPage,
  type CivilizationRevisionPageState,
  useCivilizationCensusPage,
  useCivilizationNotesPage,
  useCivilizationRetainedMailPage,
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
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { CivilizationDataRetention } from "./CivilizationDataRetention";

interface CivilizationProjectInspectionProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly targetLabel: string;
  readonly effective: CivilizationEffectiveConfig;
  readonly allowSensitiveActions: boolean;
}

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const reason = "reason" in error && typeof error.reason === "string" ? error.reason : null;
    const message = "message" in error && typeof error.message === "string" ? error.message : null;
    if (reason !== null && message !== null) return `${reason}: ${message}`;
    if (message !== null) return message;
    if ("_tag" in error && error._tag === "CivilizationConfigConflictError") {
      return "Configuration changed elsewhere; review and try again.";
    }
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Civilization operation could not be completed.";
};

function formatDate(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function PaginationMessage({ message }: { readonly message: string | null }) {
  return message === null ? null : <div className="text-xs text-muted-foreground">{message}</div>;
}

function CitizenCard({
  citizen,
  canAdminister,
  environmentId,
  effective,
  refresh,
}: {
  readonly citizen: CivilizationCitizenSummary;
  readonly canAdminister: boolean;
  readonly environmentId: EnvironmentId;
  readonly effective: CivilizationEffectiveConfig;
  readonly refresh: () => void;
}) {
  const runCitizenAction = useAtomSet(civilizationCitizenAction, { mode: "promise" });
  const [reassignOpen, setReassignOpen] = useState(false);
  const [displayName, setDisplayName] = useState(citizen.name);
  const [profileEntryId, setProfileEntryId] = useState(citizen.profileId);
  const [preview, setPreview] = useState<CivilizationCitizenReassignmentPreview | null>(null);
  const [previewRequest, setPreviewRequest] =
    useState<CivilizationCitizenReassignmentRequest | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const makeRequest = (): CivilizationCitizenReassignmentRequest => ({
    threadId: citizen.threadId,
    projectId: citizen.projectId,
    expectedCitizenRevision: citizen.revision,
    expectedEnvironmentRevision: effective.environmentRevision,
    expectedProjectRevision: effective.projectRevision,
    ...(displayName.trim() === citizen.name ? {} : { displayName: displayName.trim() }),
    ...(profileEntryId.trim() === citizen.profileId
      ? {}
      : { profileEntryId: profileEntryId.trim() }),
  });

  const previewReassignment = () => {
    if (working) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setMessage("Permission changed before preview; settings:write is required.");
      return;
    }
    const request = makeRequest();
    setWorking(true);
    setMessage(null);
    void runCitizenAction({ environmentId, type: "reassignmentPreview", request })
      .then((result) => {
        setWorking(false);
        setPreview(result as CivilizationCitizenReassignmentPreview);
        setPreviewRequest(request);
      })
      .catch((error: unknown) => {
        setWorking(false);
        setPreview(null);
        setPreviewRequest(null);
        setMessage(errorMessage(error));
      });
  };

  const applyReassignment = () => {
    if (working || previewRequest === null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setMessage("Permission changed before apply; settings:write is required.");
      return;
    }
    setWorking(true);
    setMessage(null);
    void runCitizenAction({ environmentId, type: "reassignmentApply", request: previewRequest })
      .then(() => {
        setWorking(false);
        setReassignOpen(false);
        setPreview(null);
        setPreviewRequest(null);
        refresh();
      })
      .catch((error: unknown) => {
        setWorking(false);
        setPreview(null);
        setPreviewRequest(null);
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "CivilizationConfigConflictError"
        ) {
          setMessage(
            "Configuration changed elsewhere; review the refreshed citizen and preview again.",
          );
          refresh();
          return;
        }
        setMessage(errorMessage(error));
      });
  };

  const titleAction = (type: "titleRestore" | "titleReclaim") => {
    if (working) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setMessage("Permission changed before title action; settings:write is required.");
      return;
    }
    setWorking(true);
    setMessage(null);
    void runCitizenAction({
      environmentId,
      type,
      request: {
        threadId: citizen.threadId,
        projectId: citizen.projectId,
        expectedCitizenRevision: citizen.revision,
      },
    })
      .then(() => {
        setWorking(false);
        refresh();
      })
      .catch((error: unknown) => {
        setWorking(false);
        setMessage(errorMessage(error));
      });
  };

  const state = citizen.deleted ? "Deleted" : citizen.closed ? "Closed" : "Open";
  return (
    <div className="space-y-2 rounded-lg border border-border/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-sm">{citizen.name}</div>
          <div className="wrap-anywhere text-xs text-muted-foreground">
            {citizen.profileLabel} · generation {citizen.generation} · {state} ·{" "}
            {citizen.titleManaged ? "managed title" : "manual title"}
          </div>
          <div className="wrap-anywhere text-xs text-muted-foreground">
            {citizen.parentThreadId === null
              ? "No parent"
              : `${citizen.relationshipToParent ?? "child"} of ${citizen.parentThreadId}`}
          </div>
        </div>
        {citizen.observedOnly ? (
          <span className="text-xs text-muted-foreground">Provider-owned · read only</span>
        ) : canAdminister ? (
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={() => setReassignOpen(true)}>
              Reassign identity
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={working}
              onClick={() => titleAction("titleRestore")}
            >
              Restore title
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={working}
              onClick={() => titleAction("titleReclaim")}
            >
              Reclaim title
            </Button>
          </div>
        ) : null}
      </div>
      {message === null ? null : <div className="text-xs text-destructive">{message}</div>}

      <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Reassign {citizen.name}</DialogTitle>
            <DialogDescription>
              Preview uses citizen revision {citizen.revision}, environment revision{" "}
              {effective.environmentRevision}, and project revision {effective.projectRevision}.
              Apply reuses those exact expected revisions.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1 text-sm">
              <span>Display name</span>
              <Input
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.currentTarget.value);
                  setPreview(null);
                  setPreviewRequest(null);
                }}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>Profile entry ID</span>
              <Input
                value={profileEntryId}
                onChange={(event) => {
                  setProfileEntryId(event.currentTarget.value);
                  setPreview(null);
                  setPreviewRequest(null);
                }}
              />
            </label>
            {preview === null ? null : (
              <div className="rounded-lg border border-border/70 p-3 text-sm">
                <div>
                  {preview.current.name} / {preview.current.profileLabel}
                </div>
                <div className="text-muted-foreground">→</div>
                <div>
                  {preview.proposed.name} / {preview.proposed.profileLabel}
                </div>
              </div>
            )}
            {message === null ? null : <div className="text-sm text-destructive">{message}</div>}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={working} onClick={previewReassignment}>
              {working ? "Working…" : "Preview"}
            </Button>
            <Button disabled={working || previewRequest === null} onClick={applyReassignment}>
              Apply preview
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export function CivilizationProjectInspection({
  environmentId,
  projectId,
  targetLabel,
  effective,
  allowSensitiveActions,
}: CivilizationProjectInspectionProps) {
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const censusLimit = effective.config.operations.censusPageSize;
  const inboxLimit = effective.config.operations.inboxPageSize;
  const [includeResolved, setIncludeResolved] = useState(false);
  const census = useCivilizationCensusPage(environmentId, projectId, null, censusLimit);
  const notes = useCivilizationNotesPage(
    environmentId,
    projectId,
    null,
    censusLimit,
    includeResolved,
  );
  const mail = useCivilizationRetainedMailPage(
    canWrite ? environmentId : null,
    canWrite ? projectId : null,
    null,
    inboxLimit,
  );
  const loadPage = useAtomSet(civilizationProjectReadAction, { mode: "promise" });
  const readSensitive = useAtomSet(civilizationSensitiveReadAction, { mode: "promise" });

  const [censusAccumulated, setCensusAccumulated] =
    useState<CivilizationRevisionPageState<CivilizationCitizenSummary> | null>(null);
  const [censusCursor, setCensusCursor] = useState<CivilizationCensusCursor | null>(null);
  const [censusMessage, setCensusMessage] = useState<string | null>(null);
  const [notesAccumulated, setNotesAccumulated] =
    useState<CivilizationRevisionPageState<CivilizationNoteSummary> | null>(null);
  const [notesCursor, setNotesCursor] = useState<CivilizationNotesCursor | null>(null);
  const [notesMessage, setNotesMessage] = useState<string | null>(null);
  const [mailAccumulated, setMailAccumulated] =
    useState<CivilizationRevisionPageState<CivilizationMailSummary> | null>(null);
  const [mailCursor, setMailCursor] = useState<CivilizationInboxCursor | null>(null);
  const [mailMessage, setMailMessage] = useState<string | null>(null);
  const [noteBody, setNoteBody] = useState<CivilizationNoteBody | null>(null);
  const [mailBody, setMailBody] = useState<CivilizationAdminMailRecord | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const sensitiveAllowed = allowSensitiveActions && canWrite;

  const baseCensus = census.data;
  const censusState =
    baseCensus !== null && censusAccumulated?.revision === baseCensus.revision
      ? censusAccumulated
      : baseCensus === null
        ? null
        : { status: "ready" as const, revision: baseCensus.revision, items: baseCensus.citizens };
  const nextCensusCursor =
    censusAccumulated !== null &&
    baseCensus !== null &&
    censusAccumulated.revision === baseCensus.revision
      ? censusCursor
      : (baseCensus?.nextCursor ?? null);

  const baseNotes = notes.data;
  const notesState =
    baseNotes !== null && notesAccumulated?.revision === baseNotes.revision
      ? notesAccumulated
      : baseNotes === null
        ? null
        : { status: "ready" as const, revision: baseNotes.revision, items: baseNotes.notes };
  const nextNotesCursor =
    notesAccumulated !== null &&
    baseNotes !== null &&
    notesAccumulated.revision === baseNotes.revision
      ? notesCursor
      : (baseNotes?.nextCursor ?? null);

  const baseMail = mail.data;
  const mailState =
    baseMail !== null && mailAccumulated?.revision === baseMail.revision
      ? mailAccumulated
      : baseMail === null
        ? null
        : { status: "ready" as const, revision: baseMail.revision, items: baseMail.messages };
  const nextMailCursor =
    mailAccumulated !== null && baseMail !== null && mailAccumulated.revision === baseMail.revision
      ? mailCursor
      : (baseMail?.nextCursor ?? null);

  const loadMoreCensus = () => {
    if (nextCensusCursor === null || baseCensus === null) return;
    setCensusMessage(null);
    void loadPage({
      type: "censusPage",
      environmentId,
      projectId,
      cursor: nextCensusCursor,
      limit: censusLimit,
    })
      .then((result) => {
        const page = result as CivilizationCensusPage;
        const current = censusState ?? {
          status: "ready" as const,
          revision: baseCensus.revision,
          items: baseCensus.citizens,
        };
        const merged = mergeCivilizationRevisionPage(current, {
          revision: page.revision,
          items: page.citizens,
        });
        setCensusAccumulated(merged);
        setCensusCursor(page.nextCursor);
        if (merged.status === "stale") {
          setCensusMessage("Census changed while paging; restarted from the newest page.");
          census.refresh();
        }
      })
      .catch((error: unknown) => setCensusMessage(errorMessage(error)));
  };

  const loadMoreNotes = () => {
    if (nextNotesCursor === null || baseNotes === null) return;
    setNotesMessage(null);
    void loadPage({
      type: "notesPage",
      environmentId,
      projectId,
      cursor: nextNotesCursor,
      limit: censusLimit,
      includeResolved,
    })
      .then((result) => {
        const page = result as CivilizationNotesPage;
        const current = notesState ?? {
          status: "ready" as const,
          revision: baseNotes.revision,
          items: baseNotes.notes,
        };
        const merged = mergeCivilizationRevisionPage(current, {
          revision: page.revision,
          items: page.notes,
        });
        setNotesAccumulated(merged);
        setNotesCursor(page.nextCursor);
        if (merged.status === "stale") {
          setNotesMessage("Notes changed while paging; restarted from the newest page.");
          notes.refresh();
        }
      })
      .catch((error: unknown) => setNotesMessage(errorMessage(error)));
  };

  const loadMoreMail = () => {
    if (nextMailCursor === null || baseMail === null || !sensitiveAllowed) return;
    setMailMessage(null);
    void loadPage({
      type: "mailPage",
      environmentId,
      projectId,
      cursor: nextMailCursor,
      limit: inboxLimit,
    })
      .then((result) => {
        const page = result as CivilizationAdminMailPage;
        const current = mailState ?? {
          status: "ready" as const,
          revision: baseMail.revision,
          items: baseMail.messages,
        };
        const merged = mergeCivilizationRevisionPage(current, {
          revision: page.revision,
          items: page.messages,
        });
        setMailAccumulated(merged);
        setMailCursor(page.nextCursor);
        if (merged.status === "stale") {
          setMailMessage("Retained mail changed while paging; restarted from the newest page.");
          mail.refresh();
        }
      })
      .catch((error: unknown) => setMailMessage(errorMessage(error)));
  };

  const openNoteBody = (note: CivilizationNoteSummary) => {
    if (!sensitiveAllowed || bodyLoading) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setNotesMessage("Permission changed before body inspection; settings:write is required.");
      return;
    }
    setBodyLoading(true);
    setNotesMessage(null);
    void readSensitive({ type: "noteBody", environmentId, projectId, noteId: note.noteId })
      .then((body) => {
        setBodyLoading(false);
        setNoteBody(body as CivilizationNoteBody);
      })
      .catch((error: unknown) => {
        setBodyLoading(false);
        setNotesMessage(errorMessage(error));
      });
  };

  const openMailBody = (message: CivilizationMailSummary) => {
    if (!sensitiveAllowed || bodyLoading) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setMailMessage("Permission changed before body inspection; settings:write is required.");
      return;
    }
    setBodyLoading(true);
    setMailMessage(null);
    void readSensitive({ type: "mailBody", environmentId, projectId, messageId: message.messageId })
      .then((body) => {
        setBodyLoading(false);
        setMailBody(body as CivilizationAdminMailRecord);
      })
      .catch((error: unknown) => {
        setBodyLoading(false);
        setMailMessage(errorMessage(error));
      });
  };

  return (
    <div className="space-y-8">
      <SettingsSection title={`Citizens · ${targetLabel}`} id="civilization-citizens">
        <SettingsRow
          title="Census"
          description={
            allowSensitiveActions
              ? "Project census uses revision-consistent keyset pagination."
              : "Project census for this environment. Select one environment before citizen administration."
          }
          control={
            <span className="text-sm text-muted-foreground">{censusState?.items.length ?? 0}</span>
          }
        />
        <div className="space-y-2 px-3 sm:px-4">
          {censusState?.items.map((citizen) => (
            <CitizenCard
              key={citizen.threadId}
              citizen={citizen}
              canAdminister={sensitiveAllowed}
              environmentId={environmentId}
              effective={effective}
              refresh={census.refresh}
            />
          ))}
          {census.isPending && census.data === null ? (
            <div className="text-sm text-muted-foreground">Loading census…</div>
          ) : null}
          {census.error === null ? null : (
            <div className="text-sm text-destructive">{census.error}</div>
          )}
          <PaginationMessage message={censusMessage} />
          {nextCensusCursor === null ? null : (
            <Button size="sm" variant="outline" onClick={loadMoreCensus}>
              Load more citizens
            </Button>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title={`Notes · ${targetLabel}`} id="civilization-notes">
        <SettingsRow
          title="Include resolved"
          description="Lists metadata only. Note bodies are never prefetched and require settings:write."
          control={
            <Switch
              aria-label={`Include resolved Civilization notes on ${targetLabel}`}
              checked={includeResolved}
              onCheckedChange={(checked) => {
                setIncludeResolved(checked);
                setNotesAccumulated(null);
                setNotesCursor(null);
                setNotesMessage(null);
              }}
            />
          }
        />
        <div className="space-y-2 px-3 sm:px-4">
          {notesState?.items.map((note) => (
            <div
              key={note.noteId}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/70 p-3"
            >
              <div className="min-w-0 text-xs text-muted-foreground">
                <div className="font-medium text-sm text-foreground">{note.category}</div>
                <div>
                  {note.bodyBytes} bytes · rev {note.revision} · {note.acceptedRuntimeMode}/
                  {note.acceptedInteractionMode}
                </div>
                <div>
                  author {note.authorThreadId} · updated {formatDate(note.updatedAt)}
                </div>
                <div>
                  {note.resolvedAt === null ? "Active" : `Resolved ${formatDate(note.resolvedAt)}`}
                </div>
              </div>
              {sensitiveAllowed ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={bodyLoading}
                  onClick={() => openNoteBody(note)}
                >
                  Open body
                </Button>
              ) : null}
            </div>
          ))}
          {notes.isPending && notes.data === null ? (
            <div className="text-sm text-muted-foreground">Loading notes…</div>
          ) : null}
          {notes.error === null ? null : (
            <div className="text-sm text-destructive">{notes.error}</div>
          )}
          <PaginationMessage message={notesMessage} />
          {nextNotesCursor === null ? null : (
            <Button size="sm" variant="outline" onClick={loadMoreNotes}>
              Load more notes
            </Button>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title={`Retained mail · ${targetLabel}`} id="civilization-retained-mail">
        {!canWrite ? (
          <SettingsRow
            title="Retained mail"
            description="Administrative retained-mail inspection requires settings:write."
            control={<span className="text-sm text-muted-foreground">Restricted</span>}
          />
        ) : !allowSensitiveActions ? (
          <SettingsRow
            title="Retained mail"
            description="Select one environment before inspecting retained mail or message bodies."
            control={<span className="text-sm text-muted-foreground">Choose environment</span>}
          />
        ) : (
          <div className="space-y-2 px-3 sm:px-4">
            {mailState?.items.map((message) => (
              <div
                key={message.messageId}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/70 p-3"
              >
                <div className="min-w-0 text-xs text-muted-foreground">
                  <div className="font-medium text-sm text-foreground">
                    {message.senderNameAtSend} → {message.recipientThreadId}
                  </div>
                  <div>
                    {message.bodyBytes} bytes · accepted {formatDate(message.acceptedAt)} · expires{" "}
                    {formatDate(message.expiresAt)}
                  </div>
                  <div>
                    offered {formatDate(message.lastOfferedAt)} · acknowledged{" "}
                    {formatDate(message.acknowledgedAt)}
                  </div>
                  <div>
                    {message.terminalReason === null
                      ? "Retained"
                      : `Terminal: ${message.terminalReason}`}
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={bodyLoading}
                  onClick={() => openMailBody(message)}
                >
                  Open body
                </Button>
              </div>
            ))}
            {mail.isPending && mail.data === null ? (
              <div className="text-sm text-muted-foreground">Loading retained mail…</div>
            ) : null}
            {mail.error === null ? null : (
              <div className="text-sm text-destructive">{mail.error}</div>
            )}
            <PaginationMessage message={mailMessage} />
            {nextMailCursor === null ? null : (
              <Button size="sm" variant="outline" onClick={loadMoreMail}>
                Load more mail
              </Button>
            )}
            <div className="text-xs text-muted-foreground">
              Inspection only. This UI cannot send, reply, wake, steer, or resume another agent.
            </div>
          </div>
        )}
      </SettingsSection>

      <CivilizationDataRetention
        environmentId={environmentId}
        projectId={projectId}
        environmentLabel={targetLabel}
        effective={effective}
        enabled={sensitiveAllowed}
        refreshProjectData={() => {
          census.refresh();
          notes.refresh();
          mail.refresh();
        }}
      />

      <Dialog
        open={noteBody !== null}
        onOpenChange={(open) => {
          if (!open) setNoteBody(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Note body</DialogTitle>
            <DialogDescription>
              Sensitive administrative inspection. Body text is not added to search or
              notifications.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere text-sm">
              {noteBody?.body}
            </pre>
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={mailBody !== null}
        onOpenChange={(open) => {
          if (!open) setMailBody(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Retained mail body</DialogTitle>
            <DialogDescription>
              Sensitive administrative inspection only; no send or reply action is available.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere text-sm">
              {mailBody?.body}
            </pre>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
