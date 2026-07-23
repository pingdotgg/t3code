import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { ProjectFavicon } from "./ProjectFavicon";
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
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface ProjectIconTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly title: string;
  readonly workspaceRoot: string;
}

export function replaceProjectIconSetting(
  projectIcons: Readonly<Record<string, string>>,
  workspaceRoot: string,
  iconPath: string,
): Record<string, string> {
  const next = { ...projectIcons };
  const trimmedPath = iconPath.trim();
  if (trimmedPath.length === 0) {
    delete next[workspaceRoot];
  } else {
    next[workspaceRoot] = trimmedPath;
  }
  return next;
}

function useProjectIconSetting(target: ProjectIconTarget) {
  const projectIcons = useEnvironmentSettings(
    target.environmentId,
    (settings) => settings.projectIcons,
  );
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const updateServerSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const iconPath = projectIcons[target.workspaceRoot] ?? "";
  const settingsPath =
    serverConfigs.get(target.environmentId)?.settingsConfigPath ?? "settings.json";

  const saveIconPath = useCallback(
    async (nextPath: string): Promise<boolean> => {
      const nextProjectIcons = replaceProjectIconSetting(
        projectIcons,
        target.workspaceRoot,
        nextPath,
      );
      if (
        nextProjectIcons[target.workspaceRoot] === projectIcons[target.workspaceRoot] &&
        Object.keys(nextProjectIcons).length === Object.keys(projectIcons).length
      ) {
        return true;
      }
      const result = await updateServerSettings({
        environmentId: target.environmentId,
        input: { patch: { projectIcons: nextProjectIcons } },
      });
      if (result._tag === "Success") {
        return true;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to update project icon",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return false;
    },
    [projectIcons, target.environmentId, target.workspaceRoot, updateServerSettings],
  );

  return { iconPath, saveIconPath, settingsPath };
}

export function ProjectIconPathField({ target }: { readonly target: ProjectIconTarget }) {
  const { iconPath, saveIconPath, settingsPath } = useProjectIconSetting(target);

  return (
    <label className="grid min-w-0 gap-1.5 sm:col-span-2">
      <span className="font-medium text-foreground">Custom icon path</span>
      <Input
        key={`${target.environmentId}:${target.workspaceRoot}:${iconPath}`}
        size="sm"
        aria-label={`Custom icon path for ${target.title}`}
        defaultValue={iconPath}
        placeholder="~/icons/project.svg"
        onBlur={(event) => {
          void saveIconPath(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <span className="truncate text-xs text-muted-foreground" title={settingsPath}>
        Absolute, ~/…, or project-relative. Stored in {settingsPath}.
      </span>
    </label>
  );
}

function ProjectIconDialogContent({
  target,
  onClose,
}: {
  readonly target: ProjectIconTarget;
  readonly onClose: () => void;
}) {
  const { iconPath, saveIconPath, settingsPath } = useProjectIconSetting(target);
  const [draftPath, setDraftPath] = useState(iconPath);
  const submit = async (nextPath: string) => {
    if (await saveIconPath(nextPath)) {
      toastManager.add({
        type: "success",
        title: nextPath.trim() ? "Project icon updated" : "Project icon reset",
        description: target.title,
      });
      onClose();
    }
  };

  return (
    <DialogPopup className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Project icon</DialogTitle>
        <DialogDescription>
          Set a user-local icon for {target.title} without changing the project repository.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border/70 bg-muted/25 p-3">
          <ProjectFavicon
            environmentId={target.environmentId}
            cwd={target.workspaceRoot}
            className="size-8"
          />
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{target.title}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {target.workspaceRoot}
            </p>
          </div>
        </div>
        <label className="grid gap-1.5">
          <span className="font-medium text-foreground">Icon path</span>
          <Input
            autoFocus
            aria-label={`Custom icon path for ${target.title}`}
            value={draftPath}
            placeholder="~/icons/project.svg"
            onChange={(event) => setDraftPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit(draftPath);
            }}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Use an absolute path, ~/…, or a path relative to the project. The setting is stored in{" "}
          <span className="font-mono text-xs">{settingsPath}</span>.
        </p>
        {target.environmentLabel ? (
          <p className="text-sm text-muted-foreground">Environment: {target.environmentLabel}</p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {iconPath ? (
          <Button variant="ghost" className="mr-auto" onClick={() => void submit("")}>
            Reset to automatic
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit(draftPath)}>Save</Button>
      </DialogFooter>
    </DialogPopup>
  );
}

export function ProjectIconDialog({
  target,
  onOpenChange,
}: {
  readonly target: ProjectIconTarget | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      {target ? (
        <ProjectIconDialogContent
          key={`${target.environmentId}:${target.workspaceRoot}`}
          target={target}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}
