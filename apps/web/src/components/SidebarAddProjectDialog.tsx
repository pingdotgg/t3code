import { RemoteHostId, type RemoteHostRecord } from "@t3tools/contracts";

import { isElectron } from "../env";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { SIDEBAR_INPUT_CLASSES } from "./Sidebar.helpers";
import { formatRemoteHostSummary, remoteHostSelectItems } from "./Sidebar.remoteHosts";

interface RemoteBrowseEntry {
  kind: "file" | "directory";
  path: string;
  parentPath?: string | undefined;
}

interface SidebarAddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  addProjectMode: "local" | "remote";
  onAddProjectModeChange: (mode: "local" | "remote") => void;
  newCwd: string;
  onNewCwdChange: (value: string) => void;
  isPickingFolder: boolean;
  isAddingProject: boolean;
  onPickFolder: () => void;
  selectedRemoteHostId: RemoteHostId | null;
  onSelectRemoteHost: (remoteHostId: RemoteHostId | null) => void;
  remoteHosts: readonly RemoteHostRecord[];
  onManageHosts: () => void;
  remotePath: string;
  onRemotePathChange: (value: string) => void;
  remoteBrowseQuery: string;
  onRemoteBrowseQueryChange: (value: string) => void;
  onBrowseRemotePath: () => void;
  isBrowsingRemotePath: boolean;
  remoteBrowseData: {
    cwd: string;
    entries: readonly RemoteBrowseEntry[];
  } | undefined;
  onSelectRemoteBrowseEntry: (entry: RemoteBrowseEntry) => void;
  onSubmit: () => void;
  onReset: () => void;
}

export function SidebarAddProjectDialog({
  open,
  onOpenChange,
  addProjectMode,
  onAddProjectModeChange,
  newCwd,
  onNewCwdChange,
  isPickingFolder,
  isAddingProject,
  onPickFolder,
  selectedRemoteHostId,
  onSelectRemoteHost,
  remoteHosts,
  onManageHosts,
  remotePath,
  onRemotePathChange,
  remoteBrowseQuery,
  onRemoteBrowseQueryChange,
  onBrowseRemotePath,
  isBrowsingRemotePath,
  remoteBrowseData,
  onSelectRemoteBrowseEntry,
  onSubmit,
  onReset,
}: SidebarAddProjectDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onReset();
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Add a local or remote project workspace.
          </DialogDescription>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors duration-150 ${
                addProjectMode === "local"
                  ? "border-ring bg-secondary text-foreground"
                  : "border-border text-muted-foreground/80 hover:bg-secondary"
              }`}
              onClick={() => onAddProjectModeChange("local")}
            >
              Local
            </button>
            <button
              type="button"
              className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors duration-150 ${
                addProjectMode === "remote"
                  ? "border-ring bg-secondary text-foreground"
                  : "border-border text-muted-foreground/80 hover:bg-secondary"
              }`}
              onClick={() => onAddProjectModeChange("remote")}
            >
              Remote
            </button>
          </div>
        </DialogHeader>
        <DialogPanel>
          {addProjectMode === "local" ? (
            <div className="space-y-3">
              <input
                className={`w-full font-mono ${SIDEBAR_INPUT_CLASSES}`}
                placeholder="/path/to/project"
                value={newCwd}
                onChange={(event) => onNewCwdChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSubmit();
                }}
              />
              {isElectron && (
                <button
                  type="button"
                  className="flex w-full items-center justify-center rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={onPickFolder}
                  disabled={isPickingFolder || isAddingProject}
                >
                  {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <Select
                    value={selectedRemoteHostId ?? ""}
                    onValueChange={(value) =>
                      onSelectRemoteHost(value ? RemoteHostId.makeUnsafe(value as string) : null)
                    }
                    items={{
                      "": "Select saved host",
                      ...remoteHostSelectItems(remoteHosts),
                    }}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue placeholder="Select saved host" />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="">Select saved host</SelectItem>
                      {remoteHosts.map((host) => (
                        <SelectItem key={host.id} value={host.id}>
                          {host.label} ({formatRemoteHostSummary(host)})
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground/80 transition-colors duration-150 hover:bg-secondary"
                  onClick={onManageHosts}
                >
                  Manage hosts
                </button>
              </div>
              <input
                className={`w-full font-mono ${SIDEBAR_INPUT_CLASSES}`}
                placeholder="~/project or /srv/project"
                value={remotePath}
                onChange={(event) => onRemotePathChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSubmit();
                }}
              />
              <div className="flex gap-2">
                <input
                  className={`min-w-0 flex-1 ${SIDEBAR_INPUT_CLASSES}`}
                  placeholder="Browse filter (optional)"
                  value={remoteBrowseQuery}
                  onChange={(event) => onRemoteBrowseQueryChange(event.target.value)}
                />
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground/80 transition-colors duration-150 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={onBrowseRemotePath}
                  disabled={!selectedRemoteHostId || isBrowsingRemotePath}
                >
                  {isBrowsingRemotePath ? "Loading..." : "Browse"}
                </button>
              </div>
              {remoteBrowseData && (
                <div className="rounded-md border border-border/70 bg-secondary/50 p-1">
                  <div className="px-1 pb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                    {remoteBrowseData.cwd}
                  </div>
                  <div className="max-h-48 space-y-0.5 overflow-y-auto">
                    {remoteBrowseData.entries.map((entry) => (
                      <button
                        key={`${entry.kind}:${entry.path}`}
                        type="button"
                        className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-muted-foreground/80 transition-colors duration-150 hover:bg-background hover:text-foreground"
                        onClick={() => onSelectRemoteBrowseEntry(entry)}
                      >
                        <span className="truncate">{entry.path}</span>
                        <span className="ml-2 shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/50">
                          {entry.kind}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose
            render={
              <button
                type="button"
                className="rounded-md border border-border px-4 py-1.5 text-xs text-muted-foreground/80 transition-colors duration-150 hover:bg-secondary"
              />
            }
          >
            Cancel
          </DialogClose>
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onSubmit}
            disabled={isAddingProject}
          >
            {isAddingProject ? "Adding..." : addProjectMode === "remote" ? "Add remote" : "Add project"}
          </button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
