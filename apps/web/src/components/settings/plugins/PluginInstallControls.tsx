import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderDownIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { uploadPluginFolder } from "../../../plugins/pluginFiles";
import { type PluginFolder, pickedFolder } from "../../../plugins/pluginFolders";
import type { EnvironmentPresentation } from "../../../state/environments";
import { pluginEnvironment } from "../../../state/plugins";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";

export function AddPluginButton(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const canInstall = useAtomValue(
    pluginEnvironment.createPluginUploadUrl.permissionAtom(props.environmentId),
  );
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={props.disabled || !canInstall}
      onClick={props.onClick}
    >
      Add plugin
    </Button>
  );
}

export function InstallProblems({ problems }: { readonly problems: ReadonlyArray<string> }) {
  if (problems.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-destructive text-xs">
      {problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

// For plugin authors, so it stays folded inside the Add plugin dialog.
function LinkPluginFolder({
  environmentId,
  onLinked,
}: {
  readonly environmentId: EnvironmentId;
  readonly onLinked: () => void;
}) {
  const canLink = useAtomValue(pluginEnvironment.linkPlugin.permissionAtom(environmentId));
  const link = useAtomCommand(pluginEnvironment.linkPlugin, {
    label: "plugin link",
    reportFailure: false,
  });
  const [folder, setFolder] = useState("");
  const [linking, setLinking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!canLink) return null;
  const submit = async () => {
    setLinking(true);
    setProblem(null);
    const result = await link({ environmentId, input: { folder: folder.trim() } });
    setLinking(false);
    if (result._tag === "Success") {
      setFolder("");
      return onLinked();
    }
    const error = squashAtomCommandFailure(result);
    setProblem(error instanceof Error ? error.message : "Could not link the folder.");
  };
  return (
    <div className="mt-3">
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
          Link a plugin folder
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <p className="mt-2 text-muted-foreground text-xs">
            For building a plugin. T3 Code loads the folder on the server where it is, so Reload
            runs your latest build. Give its absolute path.
          </p>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input
              size="sm"
              font="mono"
              aria-label="Plugin folder on the server"
              placeholder="/path/to/plugin"
              value={folder}
              disabled={linking}
              onChange={(event) => setFolder(event.currentTarget.value)}
            />
            <Button
              size="sm"
              variant="outline"
              type="submit"
              disabled={linking || folder.trim() === ""}
            >
              Link
            </Button>
          </form>
          <InstallProblems problems={problem === null ? [] : [problem]} />
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/**
 * Installs plugins on `environment`. A plugin without server code only changes the app, so it does
 * nothing there unless the app loads plugin UI from it, which `loadsUi` says.
 */
export function usePluginInstaller(
  environment: Pick<EnvironmentPresentation, "environmentId" | "label">,
  loadsUi: boolean,
) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);

  const run = async (work: (report: (problem: string) => void) => Promise<void>) => {
    const found: Array<string> = [];
    setProblems([]);
    await work((problem) => found.push(problem));
    setInstalling(null);
    setProblems(found);
    return found.length === 0;
  };

  return {
    installing,
    problems,
    clearProblems: () => setProblems([]),
    installFolders: (folders: ReadonlyArray<PluginFolder>) => {
      // Outside `run`, which would end the install in progress as far as the page can tell.
      if (installing !== null) {
        setProblems([`${installing} is still installing. Add more once it's done.`]);
        return Promise.resolve(false);
      }
      return run(async (report) => {
        if (folders.length === 0) return report("Drop a plugin's folder, not the files in it.");
        for (const folder of folders) {
          setInstalling(folder.name);
          const files = await folder.read().catch((error: unknown) => {
            report(error instanceof Error ? error.message : `Could not read ${folder.name}.`);
            return null;
          });
          if (files === null) continue;
          const plugin = await uploadPluginFolder(environment.environmentId, files).catch(
            (error: unknown) => {
              report(error instanceof Error ? error.message : "Could not install the plugin.");
              return null;
            },
          );
          if (plugin === null) continue;
          if (!plugin.hasServer && !loadsUi) {
            report(
              `${plugin.name} only changes the app, and this app doesn't load plugin UI from ${environment.label}, so it does nothing there.`,
            );
          }
        }
      });
    },
  };
}

export function AddPluginDialog({
  environmentId,
  open,
  onOpenChange,
  installer,
  dragActive,
  scopeNote,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly installer: ReturnType<typeof usePluginInstaller>;
  readonly dragActive: boolean;
  readonly scopeNote: string;
}) {
  const folderInput = useRef<HTMLInputElement>(null);
  const busy = installer.installing !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a plugin</DialogTitle>
          <DialogDescription>
            {scopeNote} Plugins run with the same access as T3 Code, so install only code you trust.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center",
              dragActive ? "border-primary bg-primary/5" : "border-border",
            )}
          >
            <FolderDownIcon className="size-5 text-muted-foreground" />
            <p className="text-sm">
              {busy ? `Installing ${installer.installing}…` : "Drop plugin folders here"}
            </p>
            <p className="text-muted-foreground text-xs">
              T3 Code copies each one into its plugins folder.
            </p>
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => folderInput.current?.click()}
            >
              Choose folder
            </Button>
            <input
              ref={(input) => {
                // Not in React's input props; it makes the picker choose folders, not files.
                if (input !== null) input.webkitdirectory = true;
                folderInput.current = input;
              }}
              type="file"
              hidden
              onChange={(event) => {
                const folder = pickedFolder(Array.from(event.currentTarget.files ?? []));
                // Cleared so picking the same folder again still reports a change.
                event.currentTarget.value = "";
                if (folder === undefined) return;
                void installer
                  .installFolders([folder])
                  .then((installed) => installed && onOpenChange(false));
              }}
            />
          </div>
          <InstallProblems problems={installer.problems} />
          <LinkPluginFolder environmentId={environmentId} onLinked={() => onOpenChange(false)} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
