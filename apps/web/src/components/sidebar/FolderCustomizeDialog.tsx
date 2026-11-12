import type { EnvironmentThreadFolder } from "@t3tools/client-runtime/state/thread-folders";
import { FolderOpenIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  initialProjectIconDraft,
  projectIconColorClassName,
  projectIconFromDraft,
} from "../../projectIconOptions";
import { mutateThreadFolders } from "../../state/threadFolders";
import { ProjectIconOverrideGlyph } from "../ProjectFavicon";
import { ProjectIconPicker } from "../settings/ProjectIconPickerDialog";
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
import { Label } from "../ui/label";
import { buildFolderUpdate } from "./folderCustomize.logic";
import { threadFolderTintClassName } from "./SidebarThreadFolderHeader";

const MAX_NAME_LENGTH = 80;

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function FolderCardPreview({
  folder,
  name,
  icon,
}: {
  folder: EnvironmentThreadFolder;
  name: string;
  icon: ReturnType<typeof projectIconFromDraft>;
}) {
  const color = icon && icon.kind !== "emoji" ? icon.color : null;
  const nameClassName = color ? projectIconColorClassName(color) : "text-foreground";
  return (
    <div
      aria-hidden
      className={cn(
        "flex h-9 items-center gap-2 rounded-lg border border-border/60 px-2",
        threadFolderTintClassName(icon),
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-[25%]",
          icon?.kind !== "monogram" && "bg-current/14",
          nameClassName,
        )}
      >
        {icon ? (
          <ProjectIconOverrideGlyph
            icon={icon}
            className={icon.kind === "monogram" ? "size-5" : "size-3.5"}
          />
        ) : (
          <FolderOpenIcon className="size-3.5" />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-sm font-semibold", nameClassName)}>
        {name.trim() || folder.name}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {folder.threadIds.length}
      </span>
    </div>
  );
}

export default function FolderCustomizeDialog(props: {
  folder: EnvironmentThreadFolder;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-full sm:w-[34rem]">
        {/* The popup mounts per open, so the draft below starts from the folder each time. */}
        <FolderCustomizeBody folder={props.folder} onClose={() => props.onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}

function FolderCustomizeBody({
  folder,
  onClose,
}: {
  folder: EnvironmentThreadFolder;
  onClose: () => void;
}) {
  const [name, setName] = useState(folder.name);
  const [hasIcon, setHasIcon] = useState(folder.icon !== null);
  const [iconDraft, setIconDraft] = useState(() =>
    initialProjectIconDraft(folder.icon, folder.name),
  );
  const [saving, setSaving] = useState(false);

  const icon = hasIcon ? projectIconFromDraft(iconDraft) : null;
  const iconInvalid = hasIcon && icon === null;
  const update = buildFolderUpdate(folder, { name, icon });
  const nameInvalid = name.trim() === "";

  const save = async () => {
    if (update === null) {
      onClose();
      return;
    }
    setSaving(true);
    const result = await mutateThreadFolders(folder.environmentId, update, "Could not save folder");
    setSaving(false);
    if (result !== null) onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Customize folder</DialogTitle>
        <DialogDescription>Change the folder's name, icon, and color.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <Field label="Name" htmlFor="folder-customize-name">
          <Input
            id="folder-customize-name"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            aria-invalid={nameInvalid}
            autoComplete="off"
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </Field>
        <ProjectIconPicker
          draft={iconDraft}
          onDraftChange={(draft) => {
            setIconDraft(draft);
            setHasIcon(true);
          }}
          preview={
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label render={<div />}>Preview</Label>
                {hasIcon ? (
                  <Button size="xs" variant="ghost-destructive" onClick={() => setHasIcon(false)}>
                    Remove icon
                  </Button>
                ) : null}
              </div>
              <FolderCardPreview folder={folder} name={name} icon={icon} />
            </div>
          }
        />
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving || nameInvalid || iconInvalid}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
