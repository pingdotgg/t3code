import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { T, useGT } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useChangeProjectFolder } from "../../hooks/useChangeProjectFolder";
import { useMissingProjectFolders } from "../../hooks/useMissingProjectFolders";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { readProject } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

/** Sets a checkout's folder in place: type or paste the path, or browse for it. */
export function ChangeProjectFolderPopover({
  member,
  disabled,
}: {
  member: SidebarProjectGroupMember;
  disabled: boolean;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const changeProjectFolder = useChangeProjectFolder();
  const missing = useMissingProjectFolders([member]).length > 0;
  const projectRef = scopeProjectRef(member.environmentId, member.id);

  const submit = async (path: string) => {
    if (saving) return;
    setSaving(true);
    const done = await changeProjectFolder(readProject(projectRef), path);
    setSaving(false);
    if (done) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            {...(missing
              ? {}
              : {
                  "aria-label": gt("Change folder of checkout {path}", {
                    path: member.workspaceRoot,
                  }),
                })}
          />
        }
      >
        {missing ? (
          <>
            <TriangleAlertIcon aria-hidden className="text-warning" />
            <T>Choose new folder</T>
          </>
        ) : (
          <T>Change folder</T>
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" width="lg">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const path = new FormData(event.currentTarget).get("folder");
            if (typeof path === "string") void submit(path);
          }}
        >
          <PopoverTitle>{missing ? gt("Folder not found") : gt("Project folder")}</PopoverTitle>
          <Input
            name="folder"
            size="sm"
            font="mono"
            aria-label={gt("Project folder")}
            defaultValue={member.workspaceRoot}
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="text-xs text-muted-foreground">
            <T>Type or paste the new path. Threads and settings stay with the project.</T>
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                openCommandPalette({ open: "change-project-folder", projectRef });
              }}
            >
              <T>Browse</T>
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {gt("Use folder")}
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
