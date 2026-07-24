import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { applyProjectIconUpdate } from "@t3tools/shared/serverSettings";
import { useCallback, useEffect, useRef, useState } from "react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { ProjectFavicon } from "./ProjectFavicon";
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
import { Input } from "./ui/input";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface ProjectIconTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryKey?: string | undefined;
}

export type ProjectIconScope = "workspace" | "git-remote";

export function replaceProjectIconSetting(
  input: {
    readonly projectIcons: Readonly<Record<string, string>>;
    readonly projectIconsByGitRemote: Readonly<Record<string, string>>;
  },
  target: Pick<ProjectIconTarget, "workspaceRoot" | "repositoryKey">,
  scope: ProjectIconScope,
  iconPath: string,
): {
  readonly projectIcons: Record<string, string>;
  readonly projectIconsByGitRemote: Record<string, string>;
} {
  const trimmedPath = iconPath.trim();
  return applyProjectIconUpdate(
    input,
    scope === "git-remote" && target.repositoryKey
      ? {
          scope,
          workspaceRoot: target.workspaceRoot,
          repositoryKey: target.repositoryKey,
          iconPath: trimmedPath,
        }
      : {
          scope: "workspace",
          workspaceRoot: target.workspaceRoot,
          ...(target.repositoryKey ? { repositoryKey: target.repositoryKey } : {}),
          iconPath: trimmedPath,
        },
  );
}

function useProjectIconSetting(target: ProjectIconTarget) {
  const projectIcons = useEnvironmentSettings(
    target.environmentId,
    (settings) => settings.projectIcons,
  );
  const projectIconsByGitRemote = useEnvironmentSettings(
    target.environmentId,
    (settings) => settings.projectIconsByGitRemote,
  );
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const updateServerSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const workspaceIconPath = projectIcons[target.workspaceRoot] ?? "";
  const repositoryIconPath = target.repositoryKey
    ? (projectIconsByGitRemote[target.repositoryKey] ?? "")
    : "";
  const initialScope: ProjectIconScope =
    workspaceIconPath || !target.repositoryKey ? "workspace" : "git-remote";
  const iconPath = workspaceIconPath || repositoryIconPath;
  const settingsPath =
    serverConfigs.get(target.environmentId)?.settingsConfigPath ?? "settings.json";

  const saveIconPath = useCallback(
    async (nextPath: string, scope: ProjectIconScope): Promise<boolean> => {
      const trimmedPath = nextPath.trim();
      const result = await updateServerSettings({
        environmentId: target.environmentId,
        input: {
          patch: {
            projectIconUpdate:
              scope === "git-remote" && target.repositoryKey
                ? {
                    scope,
                    workspaceRoot: target.workspaceRoot,
                    repositoryKey: target.repositoryKey,
                    iconPath: trimmedPath,
                  }
                : {
                    scope: "workspace",
                    workspaceRoot: target.workspaceRoot,
                    ...(target.repositoryKey ? { repositoryKey: target.repositoryKey } : {}),
                    iconPath: trimmedPath,
                  },
          },
        },
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
    [target, updateServerSettings],
  );

  return {
    iconPath,
    initialScope,
    repositoryIconPath,
    saveIconPath,
    settingsPath,
    workspaceIconPath,
  };
}

export function ProjectIconPathField({ target }: { readonly target: ProjectIconTarget }) {
  const { iconPath, initialScope, saveIconPath, settingsPath } = useProjectIconSetting(target);
  const [draftPath, setDraftPath] = useState(iconPath);
  const [scope, setScope] = useState<ProjectIconScope>(initialScope);
  const [pathDirty, setPathDirty] = useState(false);
  const [scopeDirty, setScopeDirty] = useState(false);
  const saveQueueRef = useRef(Promise.resolve());
  const queueSave = useCallback(
    (nextPath: string, nextScope: ProjectIconScope) => {
      const save = saveQueueRef.current.then(() => saveIconPath(nextPath, nextScope));
      saveQueueRef.current = save.then(
        () => undefined,
        () => undefined,
      );
      return save;
    },
    [saveIconPath],
  );

  useEffect(() => {
    if (pathDirty) {
      if (iconPath === draftPath.trim()) {
        setPathDirty(false);
      }
      return;
    }
    setDraftPath(iconPath);
  }, [draftPath, iconPath, pathDirty]);
  useEffect(() => {
    if (scopeDirty) {
      if (initialScope === scope) {
        setScopeDirty(false);
      }
      return;
    }
    setScope(initialScope);
  }, [initialScope, scope, scopeDirty]);

  return (
    <label className="grid min-w-0 gap-1.5 sm:col-span-2">
      <span className="font-medium text-foreground">Custom icon path</span>
      <Input
        size="sm"
        aria-label={`Custom icon path for ${target.title}`}
        value={draftPath}
        placeholder="~/icons/project.svg"
        onChange={(event) => {
          const nextPath = event.currentTarget.value;
          setDraftPath(nextPath);
          setPathDirty(true);
        }}
        onBlur={(event) => {
          void queueSave(event.currentTarget.value, scope);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {target.repositoryKey ? (
        <span className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
          <Checkbox
            aria-label={`Use icon for all clones of ${target.repositoryKey}`}
            checked={scope === "git-remote"}
            onCheckedChange={(checked) => {
              const nextScope = checked ? "git-remote" : "workspace";
              setScope(nextScope);
              setScopeDirty(true);
              void queueSave(draftPath, nextScope);
            }}
          />
          <span className="min-w-0">
            Use for all clones of{" "}
            <span className="font-mono text-[11px]">{target.repositoryKey}</span>
          </span>
        </span>
      ) : null}
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
  const { iconPath, initialScope, saveIconPath, settingsPath } = useProjectIconSetting(target);
  const [draftPath, setDraftPath] = useState(iconPath);
  const [scope, setScope] = useState<ProjectIconScope>(initialScope);
  const submit = async (nextPath: string) => {
    if (await saveIconPath(nextPath, scope)) {
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
            repositoryKey={target.repositoryKey}
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
        {target.repositoryKey ? (
          <label className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/20 p-3">
            <Checkbox
              checked={scope === "git-remote"}
              onCheckedChange={(checked) => setScope(checked ? "git-remote" : "workspace")}
            />
            <span className="grid min-w-0 gap-0.5">
              <span className="font-medium text-foreground">Use for every clone</span>
              <span className="text-sm text-muted-foreground">
                Match the normalized git remote{" "}
                <span className="font-mono text-xs">{target.repositoryKey}</span> on other machines
                and at other paths.
              </span>
            </span>
          </label>
        ) : null}
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
