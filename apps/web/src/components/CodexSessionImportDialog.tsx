import { useAtomValue } from "@effect/atom-react";
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  ArchiveIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  FolderIcon,
  Link2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { codexSessionEnvironment } from "../state/codexSessions";
import { useEnvironmentQuery } from "../state/query";
import { environmentServerConfigsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";

const INITIAL_SESSION_LIST_COUNT = 100;
const MAX_SESSION_IMPORT_SELECTION = 50;
const CODEX_PROVIDER_DRIVER = "codex";

function availableCodexProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      provider.driver === CODEX_PROVIDER_DRIVER &&
      provider.enabled &&
      provider.installed &&
      provider.status !== "disabled" &&
      provider.availability !== "unavailable",
  );
}

function providerLabel(provider: ServerProvider): string {
  return provider.displayName ?? "Codex";
}

function sessionCountLabel(count: number): string {
  return `${count} Codex session${count === 1 ? "" : "s"}`;
}

interface CodexSessionImportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly project: SidebarProjectGroupMember | null;
}

/**
 * A deliberately explicit import flow: users choose which native Codex
 * conversations become T3 threads, while the source data stays in Codex.
 */
export function CodexSessionImportDialog(props: CodexSessionImportDialogProps) {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const config = props.project ? serverConfigs.get(props.project.environmentId) : undefined;
  const supportsSessionImport = config?.environment.capabilities.codexSessionImport === true;
  const providers = useMemo(
    () => availableCodexProviders(config?.providers ?? []),
    [config?.providers],
  );
  const [providerInstanceId, setProviderInstanceId] = useState<ProviderInstanceId | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [visibleCount, setVisibleCount] = useState(INITIAL_SESSION_LIST_COUNT);
  const initializedProviderRef = useRef<ProviderInstanceId | null>(null);
  const importSessions = useAtomCommand(codexSessionEnvironment.import, { reportFailure: false });
  const [isImporting, setIsImporting] = useState(false);

  useEffect(() => {
    setProviderInstanceId((current) => {
      if (current && providers.some((provider) => provider.instanceId === current)) return current;
      return providers.at(0)?.instanceId ?? null;
    });
  }, [providers]);

  useEffect(() => {
    if (props.open) return;
    initializedProviderRef.current = null;
    setSelectedSessionIds(new Set());
    setVisibleCount(INITIAL_SESSION_LIST_COUNT);
  }, [props.open]);

  const queryAtom = useMemo(() => {
    if (!props.open || !props.project || !providerInstanceId || !supportsSessionImport) return null;
    return codexSessionEnvironment.list({
      environmentId: props.project.environmentId,
      input: {
        projectId: props.project.id,
        providerInstanceId,
      },
    });
  }, [props.open, props.project, providerInstanceId, supportsSessionImport]);
  const sessions = useEnvironmentQuery(queryAtom);
  const selectedProvider =
    providers.find((provider) => provider.instanceId === providerInstanceId) ?? null;
  const importableSessions = useMemo(
    () => sessions.data?.sessions.filter((session) => session.importedThreadId === null) ?? [],
    [sessions.data],
  );
  const importableIds = useMemo(
    () => new Set(importableSessions.map((session) => session.externalThreadId)),
    [importableSessions],
  );
  const initialSelectionIds = useMemo(
    () =>
      new Set(
        importableSessions
          .slice(0, MAX_SESSION_IMPORT_SELECTION)
          .map((session) => session.externalThreadId),
      ),
    [importableSessions],
  );
  const visibleSessions = useMemo(
    () => (sessions.data?.sessions ?? []).slice(0, visibleCount),
    [sessions.data, visibleCount],
  );

  useEffect(() => {
    if (!sessions.data || !providerInstanceId) return;
    if (initializedProviderRef.current !== providerInstanceId) {
      initializedProviderRef.current = providerInstanceId;
      setSelectedSessionIds(new Set(initialSelectionIds));
      setVisibleCount(INITIAL_SESSION_LIST_COUNT);
      return;
    }
    setSelectedSessionIds((current) => {
      const next = new Set([...current].filter((id) => importableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [importableIds, initialSelectionIds, providerInstanceId, sessions.data]);

  const selectedIds = [...selectedSessionIds].filter((id) => importableIds.has(id));
  const selectedCount = selectedIds.length;
  const selectionLimit = Math.min(importableSessions.length, MAX_SESSION_IMPORT_SELECTION);
  const selectionLimitReached = selectedCount >= MAX_SESSION_IMPORT_SELECTION;
  const allImportableSelected = importableSessions.length > 0 && selectedCount === selectionLimit;

  const toggleSession = (externalThreadId: string) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(externalThreadId)) {
        next.delete(externalThreadId);
      } else {
        const selectedImportableCount = [...next].filter((id) => importableIds.has(id)).length;
        if (selectedImportableCount >= MAX_SESSION_IMPORT_SELECTION) return current;
        next.add(externalThreadId);
      }
      return next;
    });
  };

  const handleImport = async () => {
    if (!props.project || !providerInstanceId || selectedIds.length === 0 || isImporting) return;
    setIsImporting(true);
    const result = await importSessions({
      environmentId: props.project.environmentId,
      input: {
        projectId: props.project.id,
        providerInstanceId,
        externalThreadIds: selectedIds,
      },
    });
    setIsImporting(false);

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not import Codex sessions",
          description: error instanceof Error ? error.message : "Please refresh and try again.",
        });
      }
      return;
    }

    const importedCount = result.value.importedThreadIds.length;
    const alreadyImportedCount = result.value.alreadyImportedThreadIds.length;
    toastManager.add({
      type: "success",
      title:
        importedCount > 0
          ? `Imported ${sessionCountLabel(importedCount)}`
          : "Those Codex sessions are already in T3",
      description:
        importedCount > 0
          ? "The original sessions remain unchanged in Codex."
          : `${alreadyImportedCount} selected session${alreadyImportedCount === 1 ? " is" : "s are"} already linked.`,
    });
    initializedProviderRef.current = null;
    setSelectedSessionIds(new Set());
    sessions.refresh();
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader className="gap-3 pb-2!">
          <div className="flex items-start gap-3 pe-8">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Link2Icon aria-hidden className="size-4" />
            </span>
            <div className="grid gap-1.5">
              <DialogTitle>Import Codex sessions</DialogTitle>
              <DialogDescription>
                Choose native Codex conversations for this project. T3 stores a text snapshot and a
                continuation link; the original session stays in Codex.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogPanel scrollFade={false} className="grid gap-4">
          {props.project ? (
            <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/35 px-3 py-2 text-sm">
              <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-muted-foreground">
                {props.project.workspaceRoot}
              </span>
            </div>
          ) : null}

          {!supportsSessionImport ? (
            <div className="grid gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
              <p className="font-medium text-foreground">This server needs an update</p>
              <p className="text-sm text-muted-foreground">
                Update the T3 server for this environment before importing Codex sessions.
              </p>
            </div>
          ) : providers.length === 0 ? (
            <div className="grid gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
              <p className="font-medium text-foreground">No enabled Codex provider is available</p>
              <p className="text-sm text-muted-foreground">
                Add or enable a Codex provider for this environment, then reopen this dialog.
              </p>
            </div>
          ) : (
            <>
              {providers.length > 1 && providerInstanceId ? (
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium text-foreground">Codex provider</span>
                  <Select
                    value={providerInstanceId}
                    onValueChange={(value) => {
                      setProviderInstanceId(
                        providers.find((provider) => provider.instanceId === value)?.instanceId ??
                          null,
                      );
                    }}
                  >
                    <SelectTrigger aria-label="Codex provider">
                      <SelectValue>
                        {selectedProvider ? providerLabel(selectedProvider) : "Codex"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false}>
                      {providers.map((provider) => (
                        <SelectItem key={provider.instanceId} value={provider.instanceId}>
                          {providerLabel(provider)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <div>
                  <p className="font-medium text-sm text-foreground">Available sessions</p>
                  <p className="text-sm text-muted-foreground">
                    New Codex sessions appear when you refresh this list.
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={sessions.isPending || isImporting}
                  onClick={sessions.refresh}
                >
                  <RefreshCwIcon
                    aria-hidden
                    className={cn("size-3", sessions.isPending && "animate-spin")}
                  />
                  Refresh
                </Button>
              </div>

              {sessions.error ? (
                <div className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm text-destructive-foreground">
                  <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <p>{sessions.error}</p>
                </div>
              ) : null}

              {sessions.data?.truncated ? (
                <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/7 px-3 py-2.5 text-sm text-warning-foreground">
                  <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <p>
                    Showing the 500 most recent matching sessions. Narrow your project history in
                    Codex if the session you need is not listed.
                  </p>
                </div>
              ) : null}

              {sessions.isPending && sessions.data === null ? (
                <div className="grid min-h-44 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
                  Reading Codex sessions…
                </div>
              ) : null}

              {!sessions.isPending && sessions.data && sessions.data.sessions.length === 0 ? (
                <div className="grid min-h-44 place-items-center rounded-lg border border-dashed px-6 text-center text-sm text-muted-foreground">
                  No Codex sessions match this project path yet.
                </div>
              ) : null}

              {sessions.data && sessions.data.sessions.length > 0 ? (
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">
                      {selectedCount} of {importableSessions.length} new sessions selected
                      {importableSessions.length > MAX_SESSION_IMPORT_SELECTION
                        ? ` · up to ${MAX_SESSION_IMPORT_SELECTION} at a time`
                        : ""}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={importableSessions.length === 0 || allImportableSelected}
                        onClick={() => setSelectedSessionIds(new Set(initialSelectionIds))}
                      >
                        {importableSessions.length > MAX_SESSION_IMPORT_SELECTION
                          ? `Select newest ${MAX_SESSION_IMPORT_SELECTION}`
                          : "Select all"}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={selectedCount === 0}
                        onClick={() => setSelectedSessionIds(new Set())}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                  <div className="max-h-[min(48vh,28rem)] overflow-y-auto rounded-lg border p-1">
                    {visibleSessions.map((session) => {
                      const imported = session.importedThreadId !== null;
                      const checked = selectedSessionIds.has(session.externalThreadId);
                      const selectionDisabled =
                        imported || isImporting || (!checked && selectionLimitReached);
                      return (
                        <div
                          key={session.externalThreadId}
                          className={cn(
                            "flex min-w-0 items-start gap-2 rounded-md px-2 py-2 transition-colors",
                            imported ? "opacity-65" : "hover:bg-accent/55",
                          )}
                        >
                          <Checkbox
                            aria-label={`${imported ? "Imported" : "Select"} ${session.title}`}
                            checked={imported ? true : checked}
                            disabled={selectionDisabled}
                            onCheckedChange={() => toggleSession(session.externalThreadId)}
                          />
                          <button
                            type="button"
                            className="grid min-w-0 flex-1 gap-1 text-left"
                            disabled={selectionDisabled}
                            onClick={() => toggleSession(session.externalThreadId)}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="min-w-0 flex-1 truncate font-medium text-sm text-foreground">
                                {session.title}
                              </span>
                              {imported ? (
                                <Badge size="sm" variant="success">
                                  <CheckCircle2Icon aria-hidden className="size-3" />
                                  Imported
                                </Badge>
                              ) : session.archived ? (
                                <Badge size="sm" variant="outline">
                                  <ArchiveIcon aria-hidden className="size-3" />
                                  Archived
                                </Badge>
                              ) : null}
                            </span>
                            {session.preview ? (
                              <span className="line-clamp-2 text-sm text-muted-foreground">
                                {session.preview}
                              </span>
                            ) : null}
                            <span className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{session.source}</span>
                              <span aria-hidden>·</span>
                              <span>{formatRelativeTimeLabel(session.updatedAt)}</span>
                            </span>
                          </button>
                        </div>
                      );
                    })}
                    {sessions.data.sessions.length > visibleSessions.length ? (
                      <div className="flex justify-center px-2 py-2">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setVisibleCount((count) => count + INITIAL_SESSION_LIST_COUNT)
                          }
                        >
                          Show{" "}
                          {Math.min(
                            INITIAL_SESSION_LIST_COUNT,
                            sessions.data.sessions.length - visibleSessions.length,
                          )}{" "}
                          more
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <p className="rounded-lg bg-muted/45 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                Imported history is a snapshot. Continuing a thread from T3 resumes its original
                Codex conversation, but messages added only in Codex later are not automatically
                mirrored into T3 yet.
              </p>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={isImporting}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={
              !props.project ||
              !providerInstanceId ||
              !supportsSessionImport ||
              selectedCount === 0 ||
              isImporting ||
              sessions.isPending
            }
            onClick={() => void handleImport()}
          >
            {isImporting
              ? "Importing…"
              : `Import ${selectedCount} session${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
