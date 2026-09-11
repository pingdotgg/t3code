import { getCloneDestinationPath } from "@t3tools/client-runtime/operations/projects";
import { getBrowseDirectoryPath, getBrowseLeafPathSegment } from "../../lib/projectPaths";
import { DirectoryPicker } from "../DirectoryPicker";
import { useRef, useState } from "react";
import { copyProjectToEnvironment } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectTransferMode } from "@t3tools/contracts";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogPanel,
} from "../ui/dialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { projectTransferTargets } from "./projectTransferTargets";
import { toastManager } from "../ui/toast";

export function ProjectTransferDialog({
  sources,
  destinationId,
}: {
  sources: readonly SidebarProjectGroupMember[];
  destinationId?: EnvironmentId | undefined;
}) {
  const { environments } = useEnvironments();
  const [open, setOpen] = useState(false);
  const [sourceKey, setSourceKey] = useState(sources[0]?.physicalProjectKey ?? "");
  const [pickedTarget, setTarget] = useState<EnvironmentId | "">(destinationId ?? "");
  const target = destinationId ?? pickedTarget;
  const [destinationPath, setDestinationPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [mode, setMode] = useState<ProjectTransferMode>(
    sources[0]?.repositoryIdentity ? "clone" : "copy",
  );
  const [includeIgnored, setIncludeIgnored] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const transfer = useAtomCommand(projectEnvironment.transfer, "copy project");
  const source = sources.find((item) => item.physicalProjectKey === sourceKey) ?? sources[0];
  const busy = progress !== null;
  const supported = (id: EnvironmentId) => {
    const environment = environments.find((item) => item.environmentId === id);
    return (
      environment?.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.projectTransfer === true
    );
  };
  const destinations = projectTransferTargets(environments, sources);
  const canCopy =
    sources.some((item) => supported(item.environmentId)) &&
    (destinationId
      ? destinations.some((item) => item.environmentId === destinationId)
      : destinations.length > 0);
  const ready =
    source &&
    target &&
    source.environmentId !== target &&
    supported(source.environmentId) &&
    destinations.some((item) => item.environmentId === target);
  const machineLabel = (id: EnvironmentId) => {
    const environment = environments.find((item) => item.environmentId === id);
    if (!environment) return "Machine";
    return environments.some(
      (item) => item.environmentId !== id && item.label === environment.label,
    )
      ? `${environment.label} · ${environment.displayUrl ?? id}`
      : environment.label;
  };

  async function start() {
    if (!source || !target || !ready || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setError(null);
    try {
      const result = await copyProjectToEnvironment({
        sourceEnvironmentId: source.environmentId,
        destinationEnvironmentId: target,
        projectId: source.id,
        destinationPath: destinationPath.trim(),
        mode,
        includeIgnored,
        signal: abort.signal,
        onProgress: setProgress,
        request: async (environmentId, input) => {
          const result = await transfer({ environmentId, input });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
      });
      toastManager.add({ type: "success", title: "Project copied", description: result.cwd });
      setOpen(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        abort.signal.aborted
          ? "Copy cancelled."
          : message.includes("EEXIST")
            ? "That destination folder already exists. Choose a new folder and try again."
            : message,
      );
    } finally {
      controller.current = null;
      setProgress(null);
    }
  }

  return (
    <>
      {(canCopy || destinationId) && (
        <SettingsSection title="Machines" hideTitle>
          <SettingsRow
            title={destinationId ? "No checkout on this machine" : "Copy project"}
            description={
              destinationId
                ? "Bring over a checkout and its settings from another machine."
                : "Set up this project on another machine."
            }
            status={
              !canCopy
                ? "Connect both machines using a version of T3 Code that supports project copying."
                : undefined
            }
            control={
              canCopy ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setError(null);
                    setOpen(true);
                  }}
                >
                  {destinationId ? "Copy from another machine" : "Copy to another machine"}
                </Button>
              ) : undefined
            }
          />
        </SettingsSection>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogPopup showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Copy project to another machine</DialogTitle>
            <DialogDescription>
              Create a separate checkout with this project's settings and actions. The source stays
              intact.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <div className="grid gap-1.5">
              <Label htmlFor="transfer-source">Source checkout</Label>
              <Select
                disabled={busy}
                value={source?.physicalProjectKey ?? ""}
                onValueChange={(value) => {
                  if (!value) return;
                  setSourceKey(value);
                  const next = sources.find((item) => item.physicalProjectKey === value);
                  if (!next?.repositoryIdentity) setMode("copy");
                  if (next?.environmentId === target) setTarget("");
                }}
              >
                <SelectTrigger id="transfer-source">
                  <SelectValue>
                    {source ? machineLabel(source.environmentId) : "Choose a checkout"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {sources.map((item) => (
                    <SelectItem key={item.physicalProjectKey} value={item.physicalProjectKey}>
                      <span className="min-w-0">
                        <span className="block">{machineLabel(item.environmentId)}</span>
                        <span className="block break-all text-xs text-muted-foreground">
                          {item.workspaceRoot}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <p className="break-all text-xs text-muted-foreground">{source?.workspaceRoot}</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="transfer-target">Destination machine</Label>
              <Select
                disabled={busy || destinationId !== undefined}
                value={target || null}
                onValueChange={(value) => setTarget(value ?? "")}
              >
                <SelectTrigger id="transfer-target">
                  <SelectValue placeholder="Choose a machine">
                    {target ? machineLabel(target) : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {destinations.map((item) => (
                    <SelectItem key={item.environmentId} value={item.environmentId}>
                      {machineLabel(item.environmentId)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {target && !ready && (
                <p className="text-xs text-muted-foreground">
                  Connect both machines using a version of T3 Code that supports project copying.
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="transfer-path">Destination folder</Label>
              <div className="flex gap-2">
                <Input
                  className="min-w-0 flex-1"
                  id="transfer-path"
                  value={destinationPath}
                  disabled={busy}
                  placeholder="~/code/my-project"
                  onChange={(event) => setDestinationPath(event.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={busy || !ready}
                  onClick={() => setBrowsing(true)}
                >
                  Browse…
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Browse for a parent folder, then name the new folder in the path above.
              </p>
            </div>
            <fieldset className="space-y-3">
              <legend className="mb-3 text-sm font-medium">Checkout</legend>
              <RadioGroup
                disabled={busy}
                value={mode}
                onValueChange={(value) => setMode(value as ProjectTransferMode)}
              >
                <label className="flex items-start gap-3 text-sm">
                  <Radio value="clone" disabled={!source?.repositoryIdentity} className="mt-0.5" />
                  <span>
                    Fresh checkout
                    <span className="block text-xs leading-relaxed text-muted-foreground">
                      {source?.repositoryIdentity
                        ? "Clone the default branch without local changes."
                        : "Requires a Git repository with a remote."}
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 text-sm">
                  <Radio value="copy" className="mt-0.5" />
                  <span>
                    One-time copy
                    <span className="block text-xs leading-relaxed text-muted-foreground">
                      Keep current files, Git history and uncommitted changes.
                    </span>
                  </span>
                </label>
              </RadioGroup>
              {mode === "copy" && (
                <label className="flex items-start gap-3 text-sm">
                  <Checkbox
                    disabled={busy}
                    checked={includeIgnored}
                    onCheckedChange={setIncludeIgnored}
                    className="mt-0.5"
                  />
                  <span>
                    Include ignored files
                    <span className="block text-xs leading-relaxed text-muted-foreground">
                      Includes .env and dependencies. Pause edits during the copy (up to 10 GB).
                    </span>
                  </span>
                </label>
              )}
            </fieldset>
            <p className="text-xs text-muted-foreground">
              Project settings and actions are included. Conversations and provider credentials stay
              on the source.
            </p>
            {progress && (
              <p role="status" className="text-sm">
                {progress}
              </p>
            )}
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => (busy ? controller.current?.abort() : setOpen(false))}
            >
              {busy ? "Cancel copy" : "Cancel"}
            </Button>
            <Button
              disabled={busy || !ready || !destinationPath.trim()}
              onClick={() => void start()}
            >
              Copy project
            </Button>
          </DialogFooter>
          {browsing && target && (
            <DirectoryPicker
              key={target}
              environmentId={target}
              platform={
                environments.find((item) => item.environmentId === target)?.serverConfig
                  ?.environment.platform.os ?? ""
              }
              initialPath={
                destinationPath.trim() ? getBrowseDirectoryPath(destinationPath.trim()) : "~/"
              }
              label={`Choose parent folder on ${machineLabel(target)}`}
              onClose={() => setBrowsing(false)}
              onSelect={(parentPath) => {
                const name =
                  getBrowseLeafPathSegment(destinationPath.trim()) ||
                  getBrowseLeafPathSegment(source?.workspaceRoot ?? "") ||
                  "project";
                setDestinationPath(getCloneDestinationPath(parentPath, name));
                setBrowsing(false);
              }}
            />
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
