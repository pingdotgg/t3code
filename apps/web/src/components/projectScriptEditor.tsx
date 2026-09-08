import type {
  ProjectScript,
  ProjectScriptIcon,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  BinaryIcon,
  BotIcon,
  BoxesIcon,
  BracesIcon,
  BracketsIcon,
  BrainCircuitIcon,
  BugIcon,
  CircleEllipsisIcon,
  CloudIcon,
  Code2Icon,
  ContainerIcon,
  CpuIcon,
  DatabaseIcon,
  DownloadIcon,
  FileCode2Icon,
  FlaskConicalIcon,
  FolderCodeIcon,
  GaugeIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GithubIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  Globe2Icon,
  HammerIcon,
  HardDriveIcon,
  KeyRoundIcon,
  LaptopIcon,
  ListChecksIcon,
  LockKeyholeIcon,
  MemoryStickIcon,
  MonitorIcon,
  NetworkIcon,
  PackageIcon,
  PlayIcon,
  RefreshCwIcon,
  RegexIcon,
  SearchCodeIcon,
  ServerIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SparklesIcon,
  TerminalIcon,
  UploadIcon,
  WebhookIcon,
  WorkflowIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import React, { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import { keybindingFromKeyboardEvent } from "~/components/settings/KeybindingsSettings.logic";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
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
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

const SCRIPT_ICONS: ReadonlyArray<{
  id: ProjectScriptIcon;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "play", label: "Play", icon: PlayIcon },
  { id: "test", label: "Test", icon: FlaskConicalIcon },
  { id: "lint", label: "Lint", icon: ListChecksIcon },
  { id: "configure", label: "Configure", icon: WrenchIcon },
  { id: "build", label: "Build", icon: HammerIcon },
  { id: "debug", label: "Debug", icon: BugIcon },
  { id: "terminal", label: "Terminal", icon: TerminalIcon },
  { id: "code", label: "Code", icon: Code2Icon },
  { id: "braces", label: "Braces", icon: BracesIcon },
  { id: "brackets", label: "Brackets", icon: BracketsIcon },
  { id: "file-code", label: "Code File", icon: FileCode2Icon },
  { id: "folder-code", label: "Code Folder", icon: FolderCodeIcon },
  { id: "git-branch", label: "Branch", icon: GitBranchIcon },
  { id: "git-commit", label: "Commit", icon: GitCommitHorizontalIcon },
  { id: "git-merge", label: "Merge", icon: GitMergeIcon },
  { id: "git-pull-request", label: "Pull Request", icon: GitPullRequestIcon },
  { id: "github", label: "GitHub", icon: GithubIcon },
  { id: "database", label: "Database", icon: DatabaseIcon },
  { id: "server", label: "Server", icon: ServerIcon },
  { id: "cloud", label: "Cloud", icon: CloudIcon },
  { id: "container", label: "Container", icon: ContainerIcon },
  { id: "package", label: "Package", icon: PackageIcon },
  { id: "packages", label: "Packages", icon: BoxesIcon },
  { id: "cpu", label: "CPU", icon: CpuIcon },
  { id: "memory", label: "Memory", icon: MemoryStickIcon },
  { id: "hard-drive", label: "Storage", icon: HardDriveIcon },
  { id: "network", label: "Network", icon: NetworkIcon },
  { id: "globe", label: "Web", icon: Globe2Icon },
  { id: "monitor", label: "Desktop", icon: MonitorIcon },
  { id: "smartphone", label: "Mobile", icon: SmartphoneIcon },
  { id: "laptop", label: "Laptop", icon: LaptopIcon },
  { id: "binary", label: "Binary", icon: BinaryIcon },
  { id: "regex", label: "Regex", icon: RegexIcon },
  { id: "search-code", label: "Search", icon: SearchCodeIcon },
  { id: "shield-check", label: "Verify", icon: ShieldCheckIcon },
  { id: "key", label: "Key", icon: KeyRoundIcon },
  { id: "lock", label: "Lock", icon: LockKeyholeIcon },
  { id: "webhook", label: "Webhook", icon: WebhookIcon },
  { id: "workflow", label: "Workflow", icon: WorkflowIcon },
  { id: "refresh", label: "Refresh", icon: RefreshCwIcon },
  { id: "download", label: "Download", icon: DownloadIcon },
  { id: "upload", label: "Upload", icon: UploadIcon },
  { id: "zap", label: "Fast", icon: ZapIcon },
  { id: "settings", label: "Settings", icon: Settings2Icon },
  { id: "sliders", label: "Controls", icon: SlidersHorizontalIcon },
  { id: "gauge", label: "Performance", icon: GaugeIcon },
  { id: "bot", label: "Bot", icon: BotIcon },
  { id: "brain", label: "AI", icon: BrainCircuitIcon },
  { id: "sparkles", label: "Generate", icon: SparklesIcon },
  { id: "more", label: "Other", icon: CircleEllipsisIcon },
];

const SCRIPT_ICON_BY_ID = new Map(SCRIPT_ICONS.map((entry) => [entry.id, entry.icon]));

export function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  const Icon = SCRIPT_ICON_BY_ID.get(icon) ?? PlayIcon;
  return <Icon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  keybinding: string | null;
  /** Optional URL to open in the in-app preview when this script runs. */
  previewUrl: string | null;
  /** When true, automatically open the preview panel pointed at `previewUrl`. */
  autoOpenPreview: boolean;
}

export type ProjectScriptActionResult = AtomCommandResult<void, unknown>;

export const EMPTY_PROJECT_SCRIPT_INPUT: NewProjectScriptInput = {
  name: "",
  command: "",
  icon: "play",
  runOnWorktreeCreate: false,
  keybinding: null,
  previewUrl: null,
  autoOpenPreview: false,
};

/** What the editor dialog should open with. `scriptId: null` means "add". */
export interface ProjectScriptEditorRequest {
  scriptId: string | null;
  initial: NewProjectScriptInput;
  /** Validation error to show immediately (e.g. a failed t3.json import). */
  error?: string;
}

export function editorRequestForScript(
  script: ProjectScript,
  keybindings: ResolvedKeybindingsConfig,
): ProjectScriptEditorRequest {
  return {
    scriptId: script.id,
    initial: {
      name: script.name,
      command: script.command,
      icon: script.icon,
      runOnWorktreeCreate: script.runOnWorktreeCreate,
      keybinding: keybindingValueForCommand(keybindings, commandForProjectScript(script.id)),
      previewUrl: script.previewUrl ?? null,
      autoOpenPreview: script.autoOpenPreview ?? false,
    },
  };
}

/**
 * Add/edit dialog for a project script, shared by the chat-header scripts menu
 * and the project settings page. The parent owns which script (if any) is
 * being edited via `request`; the dialog owns the form state and validation.
 */
export function ProjectScriptEditorDialog({
  request,
  scripts,
  onSubmit,
  onDelete,
  onClose,
}: {
  request: ProjectScriptEditorRequest | null;
  /** Existing scripts, used to derive a unique id for new scripts. */
  scripts: ReadonlyArray<ProjectScript>;
  onSubmit: (
    scriptId: string | null,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDelete: (scriptId: string) => void;
  onClose: () => void;
}) {
  const formId = React.useId();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [autoOpenPreview, setAutoOpenPreview] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const isOpen = request !== null;
  const isEditing = request?.scriptId != null;

  // Hydrate the form whenever a new request opens the dialog.
  useEffect(() => {
    if (!request) return;
    setName(request.initial.name);
    setCommand(request.initial.command);
    setIcon(request.initial.icon);
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(request.initial.runOnWorktreeCreate);
    setKeybinding(request.initial.keybinding ?? "");
    setPreviewUrl(request.initial.previewUrl ?? "");
    setAutoOpenPreview(request.initial.autoOpenPreview);
    setValidationError(request.error ?? null);
  }, [request]);

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromKeyboardEvent(event, navigator.platform);
    if (!next) return;
    setKeybinding(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request) return;
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError("Command is required.");
      return;
    }

    setValidationError(null);
    let payload: NewProjectScriptInput;
    try {
      const scriptIdForValidation =
        request.scriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      const trimmedPreviewUrl = previewUrl.trim();
      payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        keybinding: keybindingRule?.key ?? null,
        previewUrl: trimmedPreviewUrl.length > 0 ? trimmedPreviewUrl : null,
        autoOpenPreview: trimmedPreviewUrl.length > 0 ? autoOpenPreview : false,
      } satisfies NewProjectScriptInput;
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to save action.");
      return;
    }

    const result = await onSubmit(request.scriptId, payload);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setValidationError(error instanceof Error ? error.message : "Failed to save action.");
      }
      return;
    }
    setIconPickerOpen(false);
    onClose();
  };

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIconPickerOpen(false);
            onClose();
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Action" : "Add Action"}</DialogTitle>
            <DialogDescription>
              Actions are project-scoped commands you can run from the top bar or keybindings.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id={formId} className="space-y-4" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="script-name">Name</Label>
                <div className="flex items-center gap-2">
                  <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          className="size-9 shrink-0 hover:bg-popover active:bg-popover data-pressed:bg-popover data-pressed:shadow-xs/5 data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:border-transparent dark:bg-white/[0.035] dark:data-pressed:before:shadow-none"
                          aria-label="Choose icon"
                        />
                      }
                    >
                      <ScriptIcon icon={icon} className="size-4.5" />
                    </PopoverTrigger>
                    <PopoverPopup align="start" className="w-[min(28rem,calc(100vw-2rem))] p-2">
                      <div className="grid max-h-80 grid-cols-4 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-5">
                        {SCRIPT_ICONS.map((entry) => {
                          const isSelected = entry.id === icon;
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              className={`relative min-w-0 flex flex-col items-center gap-1.5 rounded-md border px-1 py-2 text-xs dark:border-transparent ${
                                isSelected
                                  ? "border-primary/70 bg-primary/10 dark:ring-1 dark:ring-primary/30"
                                  : "border-border/70 hover:bg-accent/60 dark:bg-white/[0.035]"
                              }`}
                              onClick={() => {
                                setIcon(entry.id);
                                setIconPickerOpen(false);
                              }}
                            >
                              <ScriptIcon icon={entry.id} className="size-4" />
                              <span className="w-full truncate text-center" title={entry.label}>
                                {entry.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </PopoverPopup>
                  </Popover>
                  <Input
                    id="script-name"
                    autoFocus
                    placeholder="Test"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-keybinding">Keybinding</Label>
                <Input
                  id="script-keybinding"
                  placeholder="Press shortcut"
                  value={keybinding}
                  readOnly
                  onKeyDown={captureKeybinding}
                />
                <p className="text-xs text-muted-foreground">
                  Press a shortcut. Use <code>Backspace</code> to clear.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-command">Command</Label>
                <Textarea
                  id="script-command"
                  placeholder="bun test"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-preview-url">Preview URL (optional)</Label>
                <Input
                  id="script-preview-url"
                  placeholder="http://localhost:5173"
                  value={previewUrl}
                  onChange={(event) => setPreviewUrl(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Open this URL in the in-app preview when this action runs.
                </p>
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
                <span>Run automatically on worktree creation</span>
                <Switch
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                />
              </label>
              <label
                className={`flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035] ${
                  previewUrl.trim().length === 0 ? "opacity-60" : ""
                }`}
              >
                <span>Open preview automatically when this action runs</span>
                <Switch
                  checked={autoOpenPreview}
                  disabled={previewUrl.trim().length === 0}
                  onCheckedChange={(checked) => setAutoOpenPreview(Boolean(checked))}
                />
              </label>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
            </form>
          </DialogPanel>
          <DialogFooter className="dark:border-transparent dark:bg-transparent">
            {isEditing && (
              <Button
                type="button"
                variant="destructive-outline"
                className="mr-auto"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                Delete
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button form={formId} type="submit">
              {isEditing ? "Save changes" : "Save action"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete action "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (!request?.scriptId) return;
                setDeleteConfirmOpen(false);
                onClose();
                onDelete(request.scriptId);
              }}
            >
              Delete action
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
