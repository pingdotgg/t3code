import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { type FormEvent, useContext, useState } from "react";

import { addBoard, openBoard } from "../state/boards";

export function CreateBoard({
  project,
  onDone,
}: {
  project: EnvironmentProject;
  onDone: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await addBoard(registry, project, name.trim());
      void openBoard(registry, { projectId: project.id, folder: created.folder });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="mx-1 my-1 flex flex-col gap-1.5 rounded-md border border-line bg-panel p-2"
    >
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Board name"
        aria-label="Board name"
        className="min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-fg placeholder:text-faint"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || name.trim() === ""}
          className="rounded-md bg-fg px-2 py-0.5 font-medium text-bg disabled:opacity-50"
        >
          Create board
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
