import { RegistryContext, useAtomMount, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useContext } from "react";

import type { EngineUpdateState } from "../state/engineUpdate";
import {
  engineUpdateOfferAtom,
  engineUpdateResumeAtom,
  engineUpdateStateAtom,
  engineVersionAtom,
  updateEngine,
} from "../state/engineUpdateAtoms";
import { engineEnvironmentIdAtom } from "../state/projects";

const STAGE_TEXT = {
  downloading: "Downloading",
  installing: "Installing",
  resuming: "Restarting",
} as const;

function updateLine(update: EngineUpdateState): { text: string; tone: string } | null {
  switch (update.status) {
    case "idle":
      return null;
    case "running":
      return { text: `${STAGE_TEXT[update.stage]} ${update.targetVersion}…`, tone: "text-muted" };
    case "failed":
      return {
        text: update.message,
        tone: "text-faint",
      };
    case "finished": {
      const { status, version, reason } = update.outcome;
      const text =
        status === "committed"
          ? `Update committed: now on ${version}`
          : `Update ${status}: still on ${version}${reason === undefined ? "" : `. ${reason}`}`;
      return { text, tone: status === "committed" ? "text-muted" : "text-faint" };
    }
  }
}

export function EngineVersion() {
  const registry = useContext(RegistryContext);
  const environmentId = useAtomValue(engineEnvironmentIdAtom);
  const version = useAtomValue(engineVersionAtom);
  const offer = useAtomValue(engineUpdateOfferAtom);
  const update = useAtomValue(engineUpdateStateAtom);

  useAtomMount(engineUpdateResumeAtom);

  if (version === null) return null;
  const line = updateLine(update);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span>Engine {version}</span>
      {line !== null && <span className={`break-words ${line.tone}`}>{line.text}</span>}
      {offer !== null && environmentId !== null && update.status !== "running" && (
        <button
          type="button"
          onClick={() =>
            void runAtomCommand(
              registry,
              updateEngine,
              { environmentId, fromVersion: version, ...offer },
              { reportFailure: false },
            )
          }
          className="self-start rounded-md bg-fg px-2 py-0.5 font-medium text-bg"
        >
          Update to {offer.targetVersion}
        </button>
      )}
    </div>
  );
}
