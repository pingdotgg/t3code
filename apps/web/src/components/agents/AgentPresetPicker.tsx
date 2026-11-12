import {
  presetSkillConflicts,
  type AgentPreset,
  type PresetSkillChoice,
  type PresetSkillConflict,
} from "@t3tools/shared/agentPresets";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  LayersIcon,
  PencilLineIcon,
  UploadIcon,
} from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
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

/** A whole-row choice: icon, title, one line of detail, chevron. */
const choiceRowClass =
  "flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

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
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === "start"
              ? "New agent"
              : step === "skills"
                ? "Skills already in your library"
                : "Preconfigured agents"}
          </DialogTitle>
          <DialogDescription>
            {step === "start"
              ? "Start from a blank agent or from a preconfigured one you can edit before saving."
              : step === "skills"
                ? "These skills share a name with different skills you already have. Nothing is deleted."
                : "Pick one to review and edit before saving."}
          </DialogDescription>
        </DialogHeader>
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
        <DialogPanel>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {step === "skills" && pending ? (
            <div className="flex flex-col gap-4">
              {pending.conflicts.map((conflict, index) => (
                <div key={conflict.index} className="flex flex-col gap-1.5">
                  <Label>{conflict.name}</Label>
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
                    <SelectTrigger aria-label={`What to do with ${conflict.name}`}>
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
                </div>
              ))}
            </div>
          ) : step === "start" ? (
            <div className="flex flex-col gap-2">
              <button type="button" className={choiceRowClass} onClick={onScratch}>
                <PencilLineIcon className="size-5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <strong className="text-sm font-medium">Start from scratch</strong>
                  <span className="text-xs text-muted-foreground">
                    Name a specialist and write its instructions yourself.
                  </span>
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
              <button type="button" className={choiceRowClass} onClick={load}>
                <LayersIcon className="size-5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <strong className="text-sm font-medium">Preconfigured</strong>
                  <span className="text-xs text-muted-foreground">
                    Start from a ready-made agent with its prompt, model and skills.
                  </span>
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2" aria-busy={presets === null && !error}>
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
                  className={choiceRowClass}
                  style={{ "--agent-color": preset.color } as CSSProperties}
                  onClick={() => pick(preset, presets)}
                >
                  <AgentIcon icon={preset.icon} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <strong className="text-sm font-medium">{preset.name}</strong>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {preset.description}
                    </span>
                    <span className="truncate font-mono text-2xs text-muted-foreground">
                      {[
                        preset.model.model,
                        preset.skills.length > 0 &&
                          `${preset.skills.length} ${preset.skills.length === 1 ? "skill" : "skills"}`,
                        preset.setupNotes.length > 0 && "needs setup",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {step === "start" ? (
            <div className="flex gap-2 sm:me-auto">
              <Button type="button" variant="ghost" onClick={() => importInput.current?.click()}>
                <UploadIcon />
                Import
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={profiles.length === 0}
                onClick={exportAgents}
              >
                <DownloadIcon />
                Export agents
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="sm:me-auto"
              onClick={() => setStep(step === "skills" ? "presets" : "start")}
            >
              <ArrowLeftIcon />
              Back
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {step === "skills" && (
            <Button type="button" onClick={confirmSkills}>
              Continue
            </Button>
          )}
        </DialogFooter>
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
