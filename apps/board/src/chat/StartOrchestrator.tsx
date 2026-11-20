import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { type FormEvent, useContext, useState } from "react";

import { ProviderPicker } from "../providers/ProviderPicker";
import {
  canStart,
  NO_PICK,
  type PickerValue,
  pickableInstances,
  resolvePick,
  selectionOf,
} from "../providers/providers";
import { startBoardOrchestrator } from "../state/orchestrator";
import { engineProvidersAtom } from "../state/server";
import type { ValidBoard } from "../store/boardFiles";

/** For a board whose orchestrator never started: the instance to run it on, and a button to start it. */
export function StartOrchestrator({
  project,
  listed,
}: {
  project: EnvironmentProject;
  listed: ValidBoard;
}) {
  const registry = useContext(RegistryContext);
  const instances = pickableInstances(useAtomValue(engineProvidersAtom));
  const [pick, setPick] = useState<PickerValue>(NO_PICK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = resolvePick(instances, pick);
  const selected = instances.find((instance) => instance.instanceId === chosen.instanceId);
  const selection = selectionOf(instances, chosen);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (selection === null) return;
    setBusy(true);
    setError(null);
    try {
      await startBoardOrchestrator(registry, project, listed, selection);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3 p-3">
      <p className="text-muted">This board has no orchestrator yet. Pick where to run it.</p>
      <ProviderPicker instances={instances} value={chosen} onChange={setPick} />
      <div>
        <button
          type="submit"
          disabled={busy || selection === null || selected === undefined || !canStart(selected)}
          className="rounded-md bg-fg px-2 py-0.5 font-medium text-bg disabled:opacity-50"
        >
          {busy ? "Starting" : "Start orchestrator"}
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
