import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderPlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { isElectron } from "../env";
import { isWindowsPlatform } from "../lib/utils";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { serverEnvironment } from "../state/server";

/**
 * Adds a manifest folder on the host's machine: the system picker when the host is this desktop
 * and shares its paths, otherwise a path on the host, which may start with `~`.
 */
export function ManifestFolderInput(props: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly onAdd: (folder: string) => Promise<void>;
  readonly label?: string;
}) {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const hostOs = useAtomValue(serverEnvironment.configValueAtom(props.hostEnvironmentId))
    ?.environment.platform.os;
  const [path, setPath] = useState("");
  const [editing, setEditing] = useState(false);
  const label = props.label ?? "Add folder";

  // A WSL host's paths are not the ones the Windows picker returns.
  const pickerPathsFitHost = !isWindowsPlatform(navigator.platform) || hostOs === "windows";
  if (isElectron && primaryEnvironmentId === props.hostEnvironmentId && pickerPathsFitHost) {
    return (
      <Button
        type="button"
        size="xs"
        variant="ghost-muted"
        onClick={() =>
          void window.desktopBridge
            ?.pickFolder()
            .then((folder) => (folder ? props.onAdd(folder) : undefined))
        }
      >
        <FolderPlusIcon className="size-3" />
        {label}
      </Button>
    );
  }
  if (!editing) {
    return (
      <Button type="button" size="xs" variant="ghost-muted" onClick={() => setEditing(true)}>
        <FolderPlusIcon className="size-3" />
        {label}
      </Button>
    );
  }
  const submit = () => {
    const folder = path.trim();
    if (folder === "") return;
    void props.onAdd(folder).then(() => {
      setPath("");
      setEditing(false);
    });
  };
  return (
    <span className="flex items-center gap-1">
      <Input
        size="sm"
        autoFocus
        aria-label="Folder on the host"
        placeholder="~/code/agents"
        value={path}
        onChange={(event) => setPath(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") setEditing(false);
        }}
        autoComplete="off"
        spellCheck={false}
      />
      <Button type="button" size="xs" variant="outline" onClick={submit}>
        Add
      </Button>
    </span>
  );
}
