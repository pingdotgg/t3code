import { RegistryContext, useAtomMount, useAtomValue } from "@effect/atom-react";
import { useContext } from "react";

import { describeEngineUpdate } from "../state/engineUpdate";
import {
  engineUpdateOfferAtom,
  engineUpdateResumeAtom,
  engineUpdateStateAtom,
  engineVersionAtom,
} from "../state/engineUpdateAtoms";
import { engineEnvironmentIdAtom } from "../state/projects";
import { runEngineUpdate } from "../state/updatesAtoms";

const NOTE_TONE = { progress: "text-muted", problem: "text-faint" } as const;

export function EngineVersion() {
  const registry = useContext(RegistryContext);
  const environmentId = useAtomValue(engineEnvironmentIdAtom);
  const version = useAtomValue(engineVersionAtom);
  const offer = useAtomValue(engineUpdateOfferAtom);
  const update = useAtomValue(engineUpdateStateAtom);

  useAtomMount(engineUpdateResumeAtom);

  if (version === null) return null;
  const note = describeEngineUpdate(update);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span>Engine {version}</span>
      {note !== null && <span className={`break-words ${NOTE_TONE[note.tone]}`}>{note.text}</span>}
      {offer !== null && environmentId !== null && update.status !== "running" && (
        <button
          type="button"
          onClick={() => void runEngineUpdate(registry)}
          className="self-start rounded-md bg-fg px-2 py-0.5 font-medium text-bg"
        >
          Update to {offer.targetVersion}
        </button>
      )}
    </div>
  );
}
