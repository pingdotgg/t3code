import { useParams } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  getAddProjectInitialQuery,
  getCloneDestinationPath,
  getCloneDirectoryName,
} from "@t3tools/client-runtime/operations/projects";
import {
  PROJECT_IGNORED_FILES_LIMIT,
  isDefaultCopiedFile,
  type EnvironmentId,
  type ProjectIgnoredFile,
  type ScopedProjectRef,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  type CloneProtocol,
  cloneUrlForProtocol,
  cloneUrlProtocol,
} from "@t3tools/shared/cloneUrl";
import { ArrowRightIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useLogicalProjectEnvironments } from "../hooks/useLogicalProjectEnvironments";
import {
  COPYABLE_FILE_MAX_BYTES,
  addProjectToMachine,
  updateIgnoredFileSelection,
} from "../lib/addProjectToMachine";
import { formatBytes } from "../lib/formatBytes";
import { newProjectId } from "../lib/utils";
import { useProject } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useDebouncedValue } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { IgnoredFileTree } from "./IgnoredFileTree";
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
import { Label } from "./ui/label";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

interface AddProjectToMachineRequest {
  readonly projectRef: ScopedProjectRef;
  readonly targetEnvironmentId: EnvironmentId | null;
}

const useRequest = create<{ request: AddProjectToMachineRequest | null }>(() => ({
  request: null,
}));

/** Opens the dialog that clones a project onto another connected machine. */
export function openAddProjectToMachine(request: AddProjectToMachineRequest) {
  useRequest.setState({ request });
}

const close = () => useRequest.setState({ request: null });

export function AddProjectToMachineDialogHost() {
  const request = useRequest((state) => state.request);
  return request ? <AddProjectToMachineDialog request={request} /> : null;
}

function AddProjectToMachineDialog({ request }: { request: AddProjectToMachineRequest }) {
  const id = useId();
  const project = useProject(request.projectRef);
  const handleNewThread = useNewThreadHandler();
  const { draftId: routeDraftId } = useParams({ strict: false });
  const { environments } = useEnvironments();
  const targets = useAddProjectTargets(project, useLogicalProjectEnvironments(project, false));
  const [targetId, setTargetId] = useState(request.targetEnvironmentId);
  const target = targets.find((t) => t.environmentId === targetId) ?? targets[0] ?? null;
  const source = environments.find((env) => env.environmentId === request.projectRef.environmentId);
  const sourceUrl =
    project?.repositoryIdentity?.origin?.remoteUrl ??
    project?.repositoryIdentity?.locator.remoteUrl ??
    "";
  const [protocol, setProtocol] = useState<CloneProtocol | null>(() => cloneUrlProtocol(sourceUrl));
  const sshUrl = cloneUrlForProtocol(sourceUrl, "ssh");
  const httpsUrl = cloneUrlForProtocol(sourceUrl, "https");
  const remoteUrl =
    (protocol === "ssh" ? sshUrl : protocol === "https" ? httpsUrl : null) ?? sourceUrl;

  const targetEnvironment = environments.find((env) => env.environmentId === target?.environmentId);
  const defaultPath = getCloneDestinationPath(
    getAddProjectInitialQuery(targetEnvironment?.serverConfig?.settings.addProjectBaseDirectory),
    getCloneDirectoryName(sourceUrl),
  );
  const [pathOverride, setPathOverride] = useState<string | null>(null);
  const destinationPath = pathOverride ?? defaultPath;

  const canListFiles = source?.serverConfig?.environment.capabilities.ignoredFileListing === true;
  const canBrowseFiles =
    source?.serverConfig?.environment.capabilities.ignoredFileBrowsing === true;
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<{ query: string; cursors: readonly string[] }>({
    query: "",
    cursors: [],
  });
  const normalizedQuery = query.trim();
  const debouncedQuery = useDebouncedValue(normalizedQuery, 200);
  const defaultIgnoredFiles = useEnvironmentQuery(
    project && canListFiles
      ? projectEnvironment.listIgnoredFiles({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null,
  );
  const listQuery = canBrowseFiles && normalizedQuery ? debouncedQuery : "";
  if (pages.query !== listQuery) {
    setPages({ query: listQuery, cursors: [] });
  }
  const cursors = canBrowseFiles && pages.query === listQuery ? pages.cursors : [];
  const after = cursors.at(-1);
  const ignoredFiles = useEnvironmentQuery(
    project && canListFiles
      ? projectEnvironment.listIgnoredFiles({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            ...(listQuery ? { query: listQuery } : {}),
            ...(after ? { after } : {}),
          },
        })
      : null,
  );
  const searchActive = listQuery.length > 0;
  const debouncing = canBrowseFiles && normalizedQuery !== debouncedQuery;
  const loadingDefaults = defaultIgnoredFiles.data === null && defaultIgnoredFiles.error === null;
  const loadingFiles = ignoredFiles.data === null && ignoredFiles.error === null;
  const listingError =
    ignoredFiles.error ??
    (canBrowseFiles && ignoredFiles.data?.truncated && !ignoredFiles.data.nextCursor
      ? "The source machine did not return the next page. Retry or return to the first page."
      : null);
  const files = loadingFiles || listingError ? [] : (ignoredFiles.data?.files ?? []);
  const pagingDisabled = loadingFiles || ignoredFiles.isPending || debouncing;
  const nextCursor = ignoredFiles.data?.nextCursor;
  const [selected, setSelected] = useState<ReadonlyMap<string, ProjectIgnoredFile> | null>(null);
  const selectedFiles = selected ?? defaultSelection(defaultIgnoredFiles.data?.files ?? []);
  const copyable = files.filter((file) => file.byteLength <= COPYABLE_FILE_MAX_BYTES);
  const selectedBytes = Array.from(selectedFiles.values()).reduce(
    (total, file) => total + file.byteLength,
    0,
  );
  const atSelectionLimit = selectedFiles.size >= PROJECT_IGNORED_FILES_LIMIT;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The project or every target can vanish while the dialog is open. Submitting
  // before the file list loads would silently skip the default .env copies.
  const unavailable = project === null || target === null || (canListFiles && loadingDefaults);
  useEffect(() => {
    if (project === null) close();
  }, [project]);

  // Lands the user on the new machine right away; its composer shows the clone
  // and holds sends until it finishes. A draft open on the source project moves
  // over with whatever was typed in it.
  const openClonedProject = (targetRef: ScopedProjectRef) => {
    const drafts = useComposerDraftStore.getState();
    const draftId = routeDraftId as DraftId | undefined;
    const draft = draftId ? drafts.getDraftSession(draftId) : null;
    if (
      draftId &&
      draft &&
      !draft.promotedTo &&
      draft.environmentId === request.projectRef.environmentId &&
      draft.projectId === request.projectRef.projectId
    ) {
      drafts.setDraftThreadContext(draftId, {
        projectRef: targetRef,
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
      });
      return;
    }
    void handleNewThread(targetRef);
  };

  const submit = async () => {
    if (!project || !target || submitting) return;
    if (destinationPath.trim().length === 0) {
      setError("Choose a folder on the other machine.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const projectId = newProjectId();
    try {
      await addProjectToMachine({
        source: { environmentId: project.environmentId, cwd: project.workspaceRoot },
        subdirectory: projectSubdirectory(
          project.repositoryIdentity?.rootPath,
          project.workspaceRoot,
        ),
        target: { environmentId: target.environmentId, label: target.label },
        projectId,
        title: project.title,
        remoteUrl,
        destinationPath: destinationPath.trim(),
        files: Array.from(selectedFiles.keys()),
      });
      close();
      openClonedProject(scopeProjectRef(target.environmentId, projectId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the clone.");
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add to another machine</DialogTitle>
            <DialogDescription>
              Clone {project?.repositoryIdentity?.displayName ?? project?.title} and bring the local
              files git does not track.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
                  <EnvironmentMachineIcon
                    kind={resolveEnvironmentMachineKind(source?.serverConfig ?? null)}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{source?.label ?? "This machine"}</span>
                </span>
                <span className="flex min-w-0 font-mono text-muted-foreground text-xs">
                  <MiddleTruncate value={project?.workspaceRoot ?? ""} />
                </span>
              </div>
              <div className="flex w-28 flex-col items-center gap-0.5 text-muted-foreground text-xs">
                <span>git clone</span>
                <span className="flex w-full items-center">
                  <span className="h-px flex-1 bg-border" />
                  <ArrowRightIcon className="-ms-1 size-3.5" aria-hidden />
                </span>
                <span>
                  {selectedFiles.size === 0
                    ? "no files"
                    : `+ ${selectedFiles.size} ${selectedFiles.size === 1 ? "file" : "files"}`}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                {targets.length > 1 ? (
                  <Select
                    value={target?.environmentId ?? null}
                    onValueChange={(value) => {
                      if (value) setTargetId(value);
                    }}
                    items={targets.map((t) => ({ value: t.environmentId, label: t.label }))}
                  >
                    <SelectTrigger size="sm" aria-label="Machine to add the project to">
                      {target ? (
                        <EnvironmentMachineIcon kind={target.machine} className="size-3.5" />
                      ) : null}
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {targets.map((t) => (
                        <SelectItem key={t.environmentId} value={t.environmentId}>
                          <span className="inline-flex items-center gap-1.5">
                            <EnvironmentMachineIcon kind={t.machine} className="size-3" />
                            {t.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
                    {target ? (
                      <EnvironmentMachineIcon kind={target.machine} className="size-3.5 shrink-0" />
                    ) : null}
                    <span className="truncate">{target?.label ?? "No machine available"}</span>
                  </span>
                )}
                <span className="flex min-w-0 font-mono text-muted-foreground text-xs">
                  <MiddleTruncate value={destinationPath} />
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Clone over</Label>
              {sshUrl && httpsUrl ? (
                <ToggleGroup
                  aria-label="Clone protocol"
                  value={protocol ? [protocol] : []}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value === "ssh" || value === "https") setProtocol(value);
                  }}
                >
                  <Toggle value="ssh">SSH</Toggle>
                  <Toggle value="https">HTTPS</Toggle>
                </ToggleGroup>
              ) : null}
              <span className="truncate font-mono text-muted-foreground text-xs">{remoteUrl}</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-path`}>Folder on {target?.label ?? "the other machine"}</Label>
              <Input
                id={`${id}-path`}
                value={destinationPath}
                onChange={(event) => setPathOverride(event.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            {canListFiles ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Label className="flex-1">Copy ignored files</Label>
                  <span className="text-muted-foreground text-xs">
                    {selectedFiles.size} selected
                    {selectedBytes > 0 ? ` · ${formatBytes(selectedBytes)}` : ""}
                  </span>
                </div>
                {canBrowseFiles ? (
                  <>
                    <Label htmlFor={`${id}-search`}>Search ignored files</Label>
                    <Input
                      id={`${id}-search`}
                      disabled={loadingDefaults}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.preventDefault();
                      }}
                      maxLength={256}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Update T3 Code on {source?.label ?? "the source machine"} to search and browse
                    more ignored files.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-muted-foreground text-xs">
                    {files.length} listed on this page
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={
                      atSelectionLimit || !copyable.some((file) => !selectedFiles.has(file.path))
                    }
                    onClick={() =>
                      setSelected(updateIgnoredFileSelection(selectedFiles, copyable, true))
                    }
                  >
                    Select listed
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={!files.some((file) => selectedFiles.has(file.path))}
                    onClick={() =>
                      setSelected(updateIgnoredFileSelection(selectedFiles, files, false))
                    }
                  >
                    Clear listed
                  </Button>
                </div>
                {loadingFiles ? (
                  <p className="text-muted-foreground text-xs">Finding ignored files…</p>
                ) : listingError ? (
                  <div className="flex items-center gap-2">
                    <p role="alert" className="flex-1 text-destructive-foreground text-xs">
                      {listingError}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={pagingDisabled}
                      onClick={ignoredFiles.refresh}
                    >
                      Retry
                    </Button>
                  </div>
                ) : files.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {cursors.length > 0 || nextCursor
                      ? "No copyable files on this page."
                      : searchActive
                        ? "No ignored files match your search."
                        : "No ignored files to copy."}
                  </p>
                ) : null}
                <IgnoredFileTree
                  files={files}
                  defaultFiles={defaultIgnoredFiles.data?.files ?? null}
                  searching={searchActive}
                  selected={selectedFiles}
                  atSelectionLimit={atSelectionLimit}
                  onCheckedChange={(file, checked) =>
                    setSelected(updateIgnoredFileSelection(selectedFiles, [file], checked))
                  }
                />
                {canBrowseFiles ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex-1 text-muted-foreground text-xs" aria-live="polite">
                      Page {cursors.length + 1}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={pagingDisabled || cursors.length === 0}
                      onClick={() => setPages({ query: listQuery, cursors: [] })}
                    >
                      First page
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={pagingDisabled || cursors.length === 0}
                      onClick={() => setPages({ query: listQuery, cursors: cursors.slice(0, -1) })}
                    >
                      Previous
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={pagingDisabled || listingError !== null || !nextCursor}
                      onClick={() => {
                        if (nextCursor) {
                          setPages({ query: listQuery, cursors: [...cursors, nextCursor] });
                        }
                      }}
                    >
                      Next
                    </Button>
                  </div>
                ) : ignoredFiles.data?.truncated ? (
                  <p className="text-muted-foreground text-xs">
                    Only the first {PROJECT_IGNORED_FILES_LIMIT} ignored files are listed.
                  </p>
                ) : null}
                {ignoredFiles.data?.outputTruncated ? (
                  <p role="status" className="text-muted-foreground text-xs">
                    Git output reached the listing limit. Some ignored files are not shown and
                    cannot be reached by paging or search.
                  </p>
                ) : null}
                {atSelectionLimit ? (
                  <p role="status" className="text-muted-foreground text-xs">
                    You can copy up to {PROJECT_IGNORED_FILES_LIMIT} files. Clear a selection to
                    choose another file.
                  </p>
                ) : null}
                <p className="text-muted-foreground text-xs">
                  Files are copied after the clone finishes. Folders git ignores whole, like
                  node_modules, are left out.
                </p>
              </div>
            ) : null}

            {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={unavailable || submitting}>
              {submitting ? "Starting…" : `Clone to ${target?.label ?? "machine"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A project can be rooted below its repository's top folder. The clone lands
 * at the top, so copied files keep the same path below it.
 */
function projectSubdirectory(repositoryRoot: string | undefined, workspaceRoot: string) {
  if (!repositoryRoot) return "";
  const prefix = repositoryRoot.replace(/[\\/]+$/, "");
  const rest = workspaceRoot.slice(prefix.length);
  return workspaceRoot.startsWith(prefix) && /^[\\/]/.test(rest)
    ? rest.slice(1).replaceAll("\\", "/")
    : "";
}

function defaultSelection(
  files: readonly ProjectIgnoredFile[],
): ReadonlyMap<string, ProjectIgnoredFile> {
  return updateIgnoredFileSelection(
    new Map(),
    files.filter((file) => isDefaultCopiedFile(file.path)),
    true,
  );
}
