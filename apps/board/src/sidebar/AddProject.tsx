import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ProjectId } from "@t3tools/contracts";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
} from "@t3tools/client-runtime/state/projects";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { FolderOpen } from "lucide-react";
import { type FormEvent, useContext, useState } from "react";

import { Tooltip } from "../ui/Tooltip";
import { engineBridge } from "../connection/bridge";
import type { FolderResult } from "../connection/engineState";
import {
  engineEnvironmentIdAtom,
  environmentProjects,
  projectEnvironment,
} from "../state/projects";

export function AddProject({ onDone }: { onDone: () => void }) {
  const registry = useContext(RegistryContext);
  const environmentId = useAtomValue(engineEnvironmentIdAtom);
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (folder: FolderResult) => {
    if (!folder.ok) return setError(folder.reason);
    if (environmentId === null) return setError("The engine is not connected yet.");
    const existing = findProjectByPath(projects, folder.path);
    if (existing !== undefined) {
      return setError(
        `${folder.path} is already a project${existing.archivedAt == null ? "" : " (hidden)"}: ${existing.title}.`,
      );
    }
    // The id is minted in an event handler, outside any Effect.
    // @effect-diagnostics-next-line cryptoRandomUUID:off
    const projectId = ProjectId.make(crypto.randomUUID());
    const result = await runAtomCommand(
      registry,
      projectEnvironment.create,
      {
        environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(folder.path),
          workspaceRoot: folder.path,
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Success") return onDone();
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : String(failure));
  };

  const run = async (resolve: () => Promise<FolderResult | null>) => {
    setBusy(true);
    setError(null);
    try {
      const folder = await resolve();
      if (folder !== null) await add(folder);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => engineBridge.resolveFolder(text));
  };

  return (
    <form
      onSubmit={submit}
      className="mx-1 mb-2 flex flex-col gap-1.5 rounded-md border border-line bg-panel p-2"
    >
      <div className="flex gap-1.5">
        <input
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="/home/you/project"
          aria-label="WSL folder path"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-fg placeholder:text-faint"
        />
        <Tooltip text="Browse for a folder" side="bottom">
          <button
            type="button"
            disabled={busy}
            aria-label="Browse for a folder"
            onClick={() => void run(() => engineBridge.pickFolder())}
            className="grid size-7 shrink-0 place-items-center rounded-md border border-line text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            <FolderOpen className="size-4" />
          </button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || text.trim() === ""}
          className="rounded-md bg-fg px-2 py-0.5 font-medium text-bg disabled:opacity-50"
        >
          Add project
        </button>
        <button type="button" onClick={onDone} className="text-muted hover:text-fg">
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
