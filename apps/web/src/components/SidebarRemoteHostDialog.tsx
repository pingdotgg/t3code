import type * as React from "react";
import { RemoteHostId, type RemoteHostRecord } from "@t3tools/contracts";

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
import {
  type RemoteHostDraft,
  formatRemoteHostSummary,
  remoteHostSelectItems,
} from "./Sidebar.remoteHosts";
import { SIDEBAR_INPUT_CLASSES } from "./Sidebar.helpers";

interface RemoteHostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remoteHosts: readonly RemoteHostRecord[];
  selectedRemoteHostId: RemoteHostId | null;
  onSelectHost: (id: RemoteHostId | null) => void;
  onCreateHost: () => void;
  remoteHostDraft: RemoteHostDraft;
  setRemoteHostDraft: React.Dispatch<React.SetStateAction<RemoteHostDraft>>;
  selectedRemoteHost: RemoteHostRecord | null;
  onSave: () => void;
  onTest: () => void;
  onRemove: (id: RemoteHostId) => void;
  isSaving: boolean;
  isTesting: boolean;
  isRemoving: boolean;
}

export function SidebarRemoteHostDialog({
  open,
  onOpenChange,
  remoteHosts,
  selectedRemoteHostId,
  onSelectHost,
  onCreateHost,
  remoteHostDraft,
  setRemoteHostDraft,
  selectedRemoteHost,
  onSave,
  onTest,
  onRemove,
  isSaving,
  isTesting,
  isRemoving,
}: RemoteHostDialogProps) {
  const formTitle = selectedRemoteHostId ? "Edit host" : "New host";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Manage remote hosts</DialogTitle>
          <DialogDescription>
            Save SSH hosts once, then reuse them when adding remote projects.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Select
                  value={selectedRemoteHostId ?? ""}
                  onValueChange={(value) =>
                    onSelectHost(value ? RemoteHostId.makeUnsafe(value as string) : null)
                  }
                  items={{
                    "": remoteHosts.length === 0 ? "No saved hosts" : "Select saved host",
                    ...remoteHostSelectItems(remoteHosts),
                  }}
                >
                  <SelectTrigger size="sm">
                    <SelectValue
                      placeholder={remoteHosts.length === 0 ? "No saved hosts" : "Select saved host"}
                    />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="" disabled>
                      {remoteHosts.length === 0 ? "No saved hosts" : "Select saved host"}
                    </SelectItem>
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
                className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
                onClick={onCreateHost}
              >
                New host
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-sm font-medium text-foreground">{formTitle}</div>
                <div className="text-xs text-muted-foreground">
                  {selectedRemoteHostId
                    ? "Update the selected host connection details."
                    : "Create a reusable SSH host for remote workspaces."}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  className={SIDEBAR_INPUT_CLASSES}
                  placeholder="Host label"
                  value={remoteHostDraft.label}
                  onChange={(event) =>
                    setRemoteHostDraft((current) => ({ ...current, label: event.target.value }))
                  }
                />
                <input
                  className={SIDEBAR_INPUT_CLASSES}
                  placeholder="SSH user"
                  value={remoteHostDraft.user}
                  onChange={(event) =>
                    setRemoteHostDraft((current) => ({ ...current, user: event.target.value }))
                  }
                />
                <input
                  className={SIDEBAR_INPUT_CLASSES}
                  placeholder="Host"
                  value={remoteHostDraft.host}
                  onChange={(event) =>
                    setRemoteHostDraft((current) => ({ ...current, host: event.target.value }))
                  }
                />
                <input
                  className={SIDEBAR_INPUT_CLASSES}
                  placeholder="Port"
                  value={remoteHostDraft.port}
                  onChange={(event) =>
                    setRemoteHostDraft((current) => ({ ...current, port: event.target.value }))
                  }
                />
                <input
                  className={SIDEBAR_INPUT_CLASSES}
                  placeholder="SSH config host (optional)"
                  value={remoteHostDraft.sshConfigHost}
                  onChange={(event) =>
                    setRemoteHostDraft((current) => ({
                      ...current,
                      sshConfigHost: event.target.value,
                    }))
                  }
                />
                <input
                  className={SIDEBAR_INPUT_CLASSES}
                  placeholder="Identity file (optional)"
                  value={remoteHostDraft.identityFile}
                  onChange={(event) =>
                    setRemoteHostDraft((current) => ({
                      ...current,
                      identityFile: event.target.value,
                    }))
                  }
                />
              </div>

              <input
                className={`w-full font-mono ${SIDEBAR_INPUT_CLASSES}`}
                placeholder="t3 remote-agent --stdio"
                value={remoteHostDraft.helperCommand}
                onChange={(event) =>
                  setRemoteHostDraft((current) => ({
                    ...current,
                    helperCommand: event.target.value,
                  }))
                }
              />

              {selectedRemoteHost && (
                <div className="rounded-xl border border-border/70 bg-secondary/60 px-3 py-3 text-xs text-muted-foreground/80">
                  <div className="font-medium text-foreground/80">
                    {formatRemoteHostSummary(selectedRemoteHost)}
                  </div>
                  <div className="mt-1">
                    Status:{" "}
                    {selectedRemoteHost.lastConnectionStatus === "ok"
                      ? "Connected"
                      : selectedRemoteHost.lastConnectionStatus === "error"
                        ? "Error"
                        : "Unknown"}
                    {selectedRemoteHost.helperVersion
                      ? ` · Helper ${selectedRemoteHost.helperVersion}`
                      : ""}
                  </div>
                  {selectedRemoteHost.lastConnectionError && (
                    <div className="mt-1 truncate text-rose-500/90">
                      {selectedRemoteHost.lastConnectionError}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          {selectedRemoteHostId && (
            <button
              type="button"
              className="mr-auto rounded-md border border-border px-3 py-1.5 text-xs text-rose-500 transition-colors duration-150 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => {
                if (selectedRemoteHostId) onRemove(selectedRemoteHostId);
              }}
              disabled={isRemoving}
            >
              {isRemoving ? "Removing..." : "Remove host"}
            </button>
          )}
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground/80 transition-colors duration-150 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onTest}
            disabled={!selectedRemoteHostId || isTesting}
          >
            {isTesting ? "Testing..." : "Test connection"}
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onSave}
            disabled={isSaving}
          >
            {isSaving ? "Saving..." : selectedRemoteHostId ? "Save changes" : "Save host"}
          </button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
