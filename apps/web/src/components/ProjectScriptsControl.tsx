import type {
  ProjectScript,
  ProjectScriptIcon,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  WrenchIcon,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
} from "~/projectScripts";
import { shortcutLabelForCommand } from "~/keybindings";
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
import { Group, GroupSeparator } from "./ui/group";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
];

function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  return <PlayIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
}

interface ProjectScriptsControlProps {
  scripts: ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
}

export default function ProjectScriptsControl({
  scripts,
  keybindings,
  onRunScript,
  onAddScript,
}: ProjectScriptsControlProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const primaryScript = useMemo(() => primaryProjectScript(scripts), [scripts]);
  const keybindingCommandPreview = useMemo(
    () =>
      commandForProjectScript(
        nextProjectScriptId(
          name.length > 0 ? name : "script",
          scripts.map((script) => script.id),
        ),
      ),
    [name, scripts],
  );

  const submitAddScript = async (event: FormEvent) => {
    event.preventDefault();
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
    try {
      await onAddScript({
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
      });
      setDialogOpen(false);
      setName("");
      setCommand("");
      setIcon("play");
      setRunOnWorktreeCreate(false);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to save action.");
    }
  };

  const openDialog = () => {
    setValidationError(null);
    setDialogOpen(true);
  };

  return (
    <>
      {primaryScript ? (
        <Group aria-label="Project scripts">
          <Button
            size="xs"
            variant="outline"
            onClick={() => onRunScript(primaryScript)}
            title={`Run ${primaryScript.name}`}
          >
            <ScriptIcon icon={primaryScript.icon} />
            <span>{primaryScript.name}</span>
          </Button>
          <GroupSeparator />
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="outline" aria-label="Script actions" />}
            >
              <ChevronDownIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {scripts.map((script) => {
                const shortcutLabel = shortcutLabelForCommand(
                  keybindings,
                  commandForProjectScript(script.id),
                );
                return (
                  <MenuItem key={script.id} onClick={() => onRunScript(script)}>
                    <ScriptIcon icon={script.icon} className="size-4" />
                    {script.runOnWorktreeCreate ? `${script.name} (Setup)` : script.name}
                    {shortcutLabel && <MenuShortcut>{shortcutLabel}</MenuShortcut>}
                  </MenuItem>
                );
              })}
              <MenuItem onClick={openDialog}>
                <PlusIcon className="size-4" />
                Add action
              </MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
      ) : (
        <Button size="xs" variant="outline" onClick={openDialog}>
          <PlusIcon className="size-3.5" />
          Add action
        </Button>
      )}

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogPopup>
          <form onSubmit={submitAddScript}>
            <DialogHeader>
              <DialogTitle>Add Action</DialogTitle>
              <DialogDescription>
                Actions are project-scoped commands you can run from the top bar or keybindings.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="script-name">Name</Label>
                <Input
                  id="script-name"
                  placeholder="Test"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Keybinding command: <code>{keybindingCommandPreview}</code>
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
                <Label>Icon</Label>
                <Select
                  items={SCRIPT_ICONS.map((entry) => ({ label: entry.label, value: entry.id }))}
                  value={icon}
                  onValueChange={(value) => {
                    if (!value) return;
                    setIcon(value as ProjectScriptIcon);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {SCRIPT_ICONS.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
                <span>Run automatically on worktree creation (Setup)</span>
                <Switch
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                />
              </label>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Save action</Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
