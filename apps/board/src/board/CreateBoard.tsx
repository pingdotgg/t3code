import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { type FormEvent, useContext, useState } from "react";

import { ProviderPicker } from "../providers/ProviderPicker";
import {
  canStart,
  defaultPick,
  NO_PICK,
  type PickerValue,
  pickableInstances,
  resolvePick,
  selectionOf,
} from "../providers/providers";
import { addBoard, openBoard } from "../state/boards";
import { startBoardOrchestrator } from "../state/orchestrator";
import { engineProvidersAtom } from "../state/server";
import type { ValidBoard } from "../store/boardFiles";

export function CreateBoard({
  project,
  onDone,
}: {
  project: EnvironmentProject;
  onDone: () => void;
}) {
  const registry = useContext(RegistryContext);
  const instances = pickableInstances(useAtomValue(engineProvidersAtom));
  const [name, setName] = useState("");
  const [pick, setPick] = useState<PickerValue>(NO_PICK);
  // Set once the board's folder exists, so a failed launch retries without a second board.
  const [created, setCreated] = useState<ValidBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = resolvePick(instances, pick);
  const reason = pick.instanceId === "" ? defaultPick(instances).reason : null;
  const selected = instances.find((instance) => instance.instanceId === chosen.instanceId);
  const selection = selectionOf(instances, chosen);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (selection === null) return;
    setBusy(true);
    setError(null);
    try {
      const board = created ?? (await addBoard(registry, project, name.trim()));
      setCreated(board);
      const started = await startBoardOrchestrator(registry, project, board, selection);
      void openBoard(registry, { projectId: project.id, folder: started.folder });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-black/50"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onDone();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Create board"
        onSubmit={(event) => void submit(event)}
        className="flex max-h-[90vh] w-[440px] max-w-[92vw] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-panel p-4 shadow-panel"
      >
        <h2 className="text-[15px] font-semibold">Create a board in {project.title}</h2>
        <label className="flex flex-col gap-1 text-muted">
          Name
          <input
            autoFocus
            value={name}
            disabled={created !== null}
            onChange={(event) => setName(event.target.value)}
            placeholder="Board name"
            aria-label="Board name"
            className="min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-fg placeholder:text-faint disabled:opacity-60"
          />
        </label>
        <div className="flex flex-col gap-1 text-muted">
          Orchestrator
          <ProviderPicker instances={instances} value={chosen} onChange={setPick} reason={reason} />
        </div>
        {error !== null && (
          <p role="alert" className="break-words text-red-400">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDone}
            disabled={busy}
            className="text-muted hover:text-fg"
          >
            {created === null ? "Cancel" : "Close"}
          </button>
          <button
            type="submit"
            disabled={
              busy ||
              (created === null && name.trim() === "") ||
              selection === null ||
              selected === undefined ||
              !canStart(selected)
            }
            className="rounded-md bg-fg px-2.5 py-1 font-medium text-bg disabled:opacity-50"
          >
            {busy ? "Starting the orchestrator" : created === null ? "Create board" : "Try again"}
          </button>
        </div>
      </form>
    </div>
  );
}
