import {
  presetSkillConflicts,
  type AgentPreset,
  type PresetSkillChoice,
  type PresetSkillConflict,
} from "@t3tools/shared/agentPresets";
import { ArrowLeftIcon, DownloadIcon, LayersIcon, PencilLineIcon, UploadIcon } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AgentIcon } from "./AgentIcon";

const loadAgentPresets = () => import("./agentPresetBundle");

const choiceValue = (choice: PresetSkillChoice) =>
  choice.kind === "new" ? "new" : `${choice.kind}:${choice.skillId}`;
const parseChoice = (value: string): PresetSkillChoice => {
  const [kind, ...rest] = value.split(":");
  const skillId = rest.join(":");
  return kind === "reuse" || kind === "update" ? { kind, skillId } : { kind: "new" };
};
const updatedLabel = (updatedAt: string) => updatedAt.slice(0, 10);

export const AGENT_PRESET_SETUP_NOTE =
  "Some agents might require specific software setup for full compatibility.";

export function AgentPresetPicker({
  loadedPresets,
  onScratch,
  onPick,
  onClose,
}: {
  /** Presets from an earlier visit; reopens the list when backing out of the editor. */
  loadedPresets: ReadonlyArray<AgentPreset> | null;
  onScratch: () => void;
  onPick: (preset: AgentPreset, presets: ReadonlyArray<AgentPreset>) => void;
  onClose: () => void;
}) {
  const { skills, profiles, loadSkills } = useAgentLibrary();
  const [presets, setPresets] = useState(loadedPresets);
  const [error, setError] = useState("");
  const [step, setStep] = useState<"start" | "presets" | "skills">(
    loadedPresets ? "presets" : "start",
  );
  const [pending, setPending] = useState<{
    preset: AgentPreset;
    presets: ReadonlyArray<AgentPreset>;
    conflicts: ReadonlyArray<PresetSkillConflict>;
    choices: ReadonlyArray<PresetSkillChoice>;
  } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const message = (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback;
  const load = () => {
    setStep("presets");
    setError("");
    if (presets) return;
    loadAgentPresets().then(
      (bundle) => setPresets(bundle.agentPresets),
      (cause: unknown) => setError(message(cause, "Could not load preconfigured agents.")),
    );
  };
  const importFile = (file: File) => {
    setStep("presets");
    setError("");
    setPresets(null);
    loadAgentPresets()
      .then((bundle) => bundle.readAgentPresetArchive(file))
      .then(setPresets, (cause: unknown) => setError(message(cause, "Could not import agents.")));
  };
  const exportAgents = () => {
    setError("");
    const selected = new Set(profiles.flatMap((profile) => profile.skillIds ?? []));
    // Skills that did not load stay as stubs, so the export names them instead of dropping them.
    Promise.all([loadAgentPresets(), loadSkills([...selected])])
      .then(([bundle, full]) =>
        bundle.downloadAgentPresetArchive(profiles, [
          ...full,
          ...skills.filter((skill) => !full.some((item) => item.skillId === skill.skillId)),
        ]),
      )
      .catch((cause: unknown) => setError(message(cause, "Could not export agents.")));
  };
  // Same-named library skills that differ get an explicit choice; identical ones are reused.
  const pick = (preset: AgentPreset, list: ReadonlyArray<AgentPreset>) => {
    const conflicts = presetSkillConflicts(skills, preset.skills);
    if (conflicts.length === 0) return onPick(preset, list);
    setPending({
      preset,
      presets: list,
      conflicts,
      choices: conflicts.map((conflict) => conflict.defaultChoice),
    });
    setStep("skills");
  };
  const confirmSkills = () => {
    if (!pending) return;
    const choices = new Map(
      pending.conflicts.map((conflict, index) => [conflict.index, pending.choices[index]!]),
    );
    onPick(
      {
        ...pending.preset,
        skills: pending.preset.skills.map((skill, index) => {
          const choice = choices.get(index);
          return choice ? { ...skill, choice } : skill;
        }),
      },
      pending.presets,
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <div className="agent-dialog p-6">
          <DialogTitle>
            {step === "start"
              ? "New agent"
              : step === "skills"
                ? "Skills already in your library"
                : "Preconfigured agents"}
          </DialogTitle>
          <DialogDescription className="mt-2">
            {step === "start"
              ? "Start from a blank agent or from a preconfigured one you can edit before saving."
              : step === "skills"
                ? "These skills share a name with different skills you already have. Nothing is deleted."
                : AGENT_PRESET_SETUP_NOTE}
          </DialogDescription>
          <input
            ref={importInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) importFile(file);
            }}
          />
          {step === "skills" && pending ? (
            <div className="agent-preset-list">
              {pending.conflicts.map((conflict, index) => (
                <label key={conflict.index} className="flex flex-col gap-1 text-sm">
                  <strong>{conflict.name}</strong>
                  <Select
                    value={choiceValue(pending.choices[index]!)}
                    onValueChange={(value) => {
                      if (value === null) return;
                      setPending({
                        ...pending,
                        choices: pending.choices.map((choice, at) =>
                          at === index ? parseChoice(value) : choice,
                        ),
                      });
                    }}
                  >
                    <SelectTrigger aria-label={`What to do with ${conflict.name}`} size="sm">
                      <SelectValue>{choiceLabel(conflict, pending.choices[index]!)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {conflict.candidates.map((candidate) => (
                        <SelectItem
                          key={`reuse:${candidate.skillId}`}
                          value={`reuse:${candidate.skillId}`}
                        >
                          {choiceLabel(conflict, { kind: "reuse", skillId: candidate.skillId })}
                        </SelectItem>
                      ))}
                      {conflict.candidates.map((candidate) => (
                        <SelectItem
                          key={`update:${candidate.skillId}`}
                          value={`update:${candidate.skillId}`}
                        >
                          {choiceLabel(conflict, { kind: "update", skillId: candidate.skillId })}
                        </SelectItem>
                      ))}
                      <SelectItem value="new">{choiceLabel(conflict, { kind: "new" })}</SelectItem>
                    </SelectPopup>
                  </Select>
                </label>
              ))}
            </div>
          ) : step === "start" ? (
            <>
              {error && (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="agent-start-options">
                <button type="button" onClick={onScratch}>
                  <PencilLineIcon size={20} />
                  <strong>Start from scratch</strong>
                  <span>Name a specialist and write its instructions yourself.</span>
                </button>
                <button type="button" onClick={load}>
                  <LayersIcon size={20} />
                  <strong>Preconfigured</strong>
                  <span>Start from a ready-made agent with its prompt, model and skills.</span>
                </button>
              </div>
            </>
          ) : (
            <div className="agent-preset-list" aria-busy={presets === null && !error}>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {!error && presets === null && (
                <p className="text-sm text-muted-foreground">Loading…</p>
              )}
              {presets?.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  This version of T3 Code has no preconfigured agents.
                </p>
              )}
              {presets?.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="agent-preset-card"
                  style={{ "--agent-color": preset.color } as CSSProperties}
                  onClick={() => pick(preset, presets)}
                >
                  <AgentIcon icon={preset.icon} />
                  <span className="agent-preset-body">
                    <strong>{preset.name}</strong>
                    <span>{preset.description}</span>
                    <span className="agent-preset-meta">
                      {preset.model.model}
                      {preset.skills.length > 0 &&
                        ` · ${preset.skills.map((skill) => skill.name).join(", ")}`}
                    </span>
                    {preset.setupNotes.length > 0 && (
                      <ul className="agent-preset-notes">
                        {preset.setupNotes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="agent-form">
            <footer>
              {step === "start" && (
                <>
                  <button type="button" onClick={() => importInput.current?.click()}>
                    <UploadIcon size={14} className="inline" /> Import
                  </button>
                  <button
                    type="button"
                    className="mr-auto"
                    disabled={profiles.length === 0}
                    onClick={exportAgents}
                  >
                    <DownloadIcon size={14} className="inline" /> Export agents
                  </button>
                </>
              )}
              {step !== "start" && (
                <button
                  type="button"
                  className="mr-auto"
                  onClick={() => setStep(step === "skills" ? "presets" : "start")}
                >
                  <ArrowLeftIcon size={14} className="inline" /> Back
                </button>
              )}
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              {step === "skills" && (
                <button type="button" className="agent-primary" onClick={confirmSkills}>
                  Continue
                </button>
              )}
            </footer>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function choiceLabel(conflict: PresetSkillConflict, choice: PresetSkillChoice) {
  if (choice.kind === "new") return "Add the preset's version as a new skill";
  const skill = conflict.candidates.find((candidate) => candidate.skillId === choice.skillId);
  const which =
    conflict.candidates.length > 1 && skill ? ` (updated ${updatedLabel(skill.updatedAt)})` : "";
  return choice.kind === "reuse"
    ? `Use my existing skill${which}`
    : `Replace my skill${which} with the preset's version`;
}
