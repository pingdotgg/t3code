import { CheckIcon } from "lucide-react";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "../ui/combobox";
import { SelectButton } from "../ui/select";
import { Switch } from "../ui/switch";
import { agentModelOptions, presetProviderLabel } from "./agentModelCatalog";
import type { AgentSkill, McpGatewayProfile, ServerProvider } from "@t3tools/contracts";
import { MCP_GATEWAY_RUNTIME_MODE_LABELS } from "@t3tools/contracts";
import {
  agentColors,
  agentHasAdvancedSettings,
  defaultAgentColor,
  soleOption,
} from "./agents.logic";
import {
  agentIconFieldsToSave,
  normalizeAgentTags,
  resolveAgentIconId,
  type AgentIconId,
} from "@t3tools/client-runtime/state/agentIdentity";
import { AgentIconPicker } from "./AgentIconPicker";
import { AgentTagsField } from "./AgentTagsField";
import { AGENT_PRESET_SETUP_NOTE } from "./AgentPresetPicker";
import { useRef, useState, type CSSProperties } from "react";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { randomUUID } from "../../lib/utils";
import {
  findIdenticalSkill,
  type AgentPreset,
  type AgentPresetSkill,
} from "@t3tools/shared/agentPresets";

const emptySkills: ReadonlyArray<AgentSkill> = [];
const PRESET_SKILL_PREFIX = "preset:";

export function AgentEditor({
  profile,
  profiles,
  skills = emptySkills,
  providers,
  machines,
  preset = null,
  skillsAvailable = true,
  onSave,
  onBack,
  onClose,
}: {
  profile: McpGatewayProfile | null;
  profiles: ReadonlyArray<McpGatewayProfile>;
  skills?: ReadonlyArray<AgentSkill>;
  providers: ReadonlyArray<ServerProvider & { readonly environmentId: string }>;
  machines: ReadonlyArray<{ environmentId: string; label: string }>;
  /** Prefills a new agent; its skills join the library on save. */
  preset?: AgentPreset | null;
  skillsAvailable?: boolean;
  /** Preset skills not already in the library are passed for the caller to add. */
  onSave: (
    profile: McpGatewayProfile,
    presetSkills: ReadonlyArray<AgentPresetSkill>,
  ) => Promise<boolean | undefined>;
  onBack?: () => void;
  onClose: () => void;
}) {
  const skillsTriggerRef = useRef<HTMLButtonElement>(null);
  // Preset skills already in the library preselect that skill instead of a copy.
  const presetSkills = skillsAvailable && preset ? preset.skills : [];
  const presetSkillIds = presetSkills.map(
    (skill, index) =>
      findIdenticalSkill(skills, skill)?.skillId ??
      (skill.choice && skill.choice.kind !== "new"
        ? skill.choice.skillId
        : `${PRESET_SKILL_PREFIX}${index}`),
  );
  const updatedSkillIds = new Set(
    presetSkills.flatMap((skill) =>
      skill.choice?.kind === "update" ? [skill.choice.skillId] : [],
    ),
  );
  const skillOptions = [
    ...skills.map((skill) => ({
      id: skill.skillId,
      name: updatedSkillIds.has(skill.skillId) ? `${skill.name} (updated)` : skill.name,
      description: skill.description,
    })),
    ...presetSkills.flatMap((skill, index) =>
      presetSkillIds[index]!.startsWith(PRESET_SKILL_PREFIX)
        ? [
            {
              id: presetSkillIds[index]!,
              name: `${skill.name} (new)`,
              description: skill.description,
            },
          ]
        : [],
    ),
  ];
  const [skillIds, setSkillIds] = useState<ReadonlyArray<string>>(
    profile?.skillIds ?? [...new Set(presetSkillIds)],
  );
  const [includeUserSkills, setIncludeUserSkills] = useState(profile?.includeUserSkills !== false);
  const [systemPrompt, setSystemPrompt] = useState(
    profile?.systemPrompt ?? preset?.systemPrompt ?? "",
  );
  const [color, setColor] = useState(
    profile?.color ?? preset?.color ?? defaultAgentColor(profile, profiles),
  );
  const [pickedIcon, setPickedIcon] = useState<AgentIconId | null>(null);
  const iconId = pickedIcon ?? resolveAgentIconId(profile ?? preset);
  const [tags, setTags] = useState<ReadonlyArray<string>>(profile?.tags ?? preset?.tags ?? []);
  const [advancedOpen, setAdvancedOpen] = useState(
    () => profile !== null && agentHasAdvancedSettings(profile, profiles),
  );
  const [description, setDescription] = useState(profile?.description ?? preset?.description ?? "");
  const [name, setName] = useState(profile?.name ?? preset?.name ?? "");
  const [providerLabel, setProviderLabel] = useState(
    profile?.providerLabel ?? (preset ? presetProviderLabel(providers, preset.model.provider) : ""),
  );
  const [modelLabel, setModelLabel] = useState(profile?.modelLabel ?? preset?.model.model ?? "");
  const [thinking, setThinking] = useState(
    profile?.reasoningEffort ?? preset?.model.reasoningEffort ?? "",
  );
  const [runtimeMode, setRuntimeMode] = useState<McpGatewayProfile["runtimeMode"]>(
    profile?.runtimeMode ?? preset?.runtimeMode ?? "approval-required",
  );
  const [interactionMode, setInteractionMode] = useState<McpGatewayProfile["interactionMode"]>(
    profile?.interactionMode ?? preset?.interactionMode ?? "default",
  );
  const [environmentIds, setEnvironmentIds] = useState<ReadonlyArray<string>>(
    profile?.environmentIds ?? [],
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const availableProviders = providers.filter(
    (provider) => environmentIds.length === 0 || environmentIds.includes(provider.environmentId),
  );
  const providerLabels = [
    ...new Set(
      availableProviders.filter((p) => p.enabled).map((p) => p.displayName?.trim() || p.driver),
    ),
  ];
  // With a single choice there is nothing to pick, so it is preselected.
  const provider = providerLabel || (soleOption(providerLabels) ?? "");
  const models = agentModelOptions(providers, environmentIds, provider);
  const model = modelLabel || (soleOption(models)?.slug ?? "");
  const selectedModel =
    models.find((item) => item.slug === model) ??
    (models.filter((item) => item.name === model).length === 1
      ? models.find((item) => item.name === model)
      : undefined);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup>
        <div className="agent-dialog p-6">
          <DialogTitle>
            {profile ? "Edit agent" : preset ? `Create agent from ${preset.name}` : "Create agent"}
          </DialogTitle>
          <DialogDescription className="mt-2">
            Name a specialist and choose its model. It starts working when you give it a task.
          </DialogDescription>
          {preset && (
            <div className="agent-preset-setup" role="note">
              <p>{AGENT_PRESET_SETUP_NOTE}</p>
              {preset.setupNotes.length > 0 && (
                <ul>
                  {preset.setupNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
              {!skillsAvailable && preset.skills.length > 0 && (
                <p>Update T3 Code on this machine to add this preset’s skills.</p>
              )}
            </div>
          )}
          <form
            className="agent-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const nameKey = name.trim().toLocaleLowerCase();
              if (
                profiles.some(
                  (p) =>
                    p.profileId !== profile?.profileId &&
                    p.name.trim().toLocaleLowerCase() === nameKey,
                )
              ) {
                setError("An agent with this name already exists.");
                return;
              }
              setSaving(true);
              setError("");
              const normalizedTags = normalizeAgentTags(tags);
              // oxlint-disable-next-line react/purity -- captures the save time inside the submit handler (oxc#27309)
              const now = new Date().toISOString();
              try {
                const saved = await onSave(
                  {
                    profileId: profile?.profileId ?? randomUUID(),
                    name: name.trim(),
                    description: description.trim(),
                    systemPrompt,
                    skillIds: skillIds.filter((id) => !id.startsWith(PRESET_SKILL_PREFIX)),
                    ...(includeUserSkills ? {} : { includeUserSkills: false }),
                    color,
                    ...agentIconFieldsToSave(profile ?? preset, pickedIcon),
                    ...(normalizedTags.length ? { tags: normalizedTags } : {}),
                    revision: profile?.revision ?? 1,
                    providerLabel: provider,
                    modelLabel: selectedModel?.slug ?? model,
                    ...(thinking.trim() ? { reasoningEffort: thinking.trim() } : {}),
                    runtimeMode,
                    interactionMode,
                    ...(environmentIds.length ? { environmentIds } : {}),
                    createdAt: profile?.createdAt ?? now,
                    updatedAt: now,
                  },
                  presetSkills.filter(
                    (skill, index) =>
                      skillIds.includes(presetSkillIds[index]!) &&
                      (presetSkillIds[index]!.startsWith(PRESET_SKILL_PREFIX) ||
                        skill.choice?.kind === "update"),
                  ),
                );
                if (saved) onClose();
                else setError("Could not save the agent. Check your connection and try again.");
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not save agent.");
              }
              setSaving(false);
            }}
          >
            <div className="agent-name-row" style={{ "--agent-color": color } as CSSProperties}>
              <AgentIconPicker value={iconId} onChange={setPickedIcon} />
              <label>
                Name
                <input
                  autoFocus
                  required
                  maxLength={200}
                  placeholder="Write, Review, Research…"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            </div>
            <AgentTagsField tags={tags} onChange={setTags} />
            <div className="agent-form-grid">
              <label>
                Provider
                <select
                  required
                  value={provider}
                  onChange={(e) => {
                    setProviderLabel(e.target.value);
                    setModelLabel("");
                  }}
                >
                  <option value="">Select provider</option>
                  {[...new Set([...providerLabels, ...(provider ? [provider] : [])])].map(
                    (label) => (
                      <option key={label}>{label}</option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Model
                <select
                  required
                  value={selectedModel?.slug ?? model}
                  onChange={(e) => setModelLabel(e.target.value)}
                >
                  <option value="">Select model</option>
                  {model && !selectedModel && (
                    <option value={model} disabled>
                      {model}: unavailable; select a model
                    </option>
                  )}
                  {models.map((option) => (
                    <option key={option.slug} value={option.slug}>
                      {option.name} ({option.slug})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {preset && model === preset.model.model && !selectedModel && (
              <p role="alert" className="text-sm text-warning">
                {providerLabels.includes(provider)
                  ? `${model} isn’t available from ${provider}.`
                  : `${provider} isn’t installed on a connected machine.`}{" "}
                Choose an available provider and model to save this agent.
              </p>
            )}
            <details
              className="agent-advanced"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary>Advanced</summary>
              <div className="agent-advanced-body">
                <label>
                  Specialization
                  <input
                    maxLength={280}
                    placeholder="Reviews code for correctness, security, and maintainability"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">
                    A short description shown on the board and in MCP.
                  </span>
                </label>
                <fieldset className="agent-appearance">
                  <legend>Color</legend>
                  <div className="agent-color-options">
                    <input
                      type="color"
                      aria-label="Custom color"
                      value={color}
                      onChange={(event) => setColor(event.target.value)}
                    />
                    {agentColors.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-label={`Use color ${value}`}
                        aria-pressed={color === value}
                        style={{ background: value }}
                        onClick={() => setColor(value)}
                      />
                    ))}
                  </div>
                </fieldset>
                <label>
                  System prompt
                  <textarea
                    rows={6}
                    maxLength={32000}
                    value={systemPrompt}
                    onChange={(event) => setSystemPrompt(event.target.value)}
                    placeholder="Describe this agent’s role, workflow, and expected output…"
                  />
                  <span className="text-xs text-muted-foreground">
                    Agent configuration and skill changes apply to new chats. Existing chats keep
                    their starting configuration.
                  </span>
                </label>
                <fieldset>
                  <legend>Skills</legend>
                  {skillOptions.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Add reusable skills from the Agents board.
                    </p>
                  )}
                  {skillOptions.length > 0 && (
                    <Combobox
                      multiple
                      items={skillOptions.map((skill) => skill.id)}
                      value={[...skillIds]}
                      onValueChange={setSkillIds}
                      itemToStringLabel={(id) =>
                        skillOptions.find((skill) => skill.id === id)?.name ?? id
                      }
                    >
                      <ComboboxTrigger
                        ref={skillsTriggerRef}
                        aria-label="Select skills"
                        render={<SelectButton className="w-full" />}
                      >
                        {skillIds.length === 0
                          ? "Select skills…"
                          : skillIds.length === 1
                            ? (skillOptions.find((skill) => skill.id === skillIds[0])?.name ??
                              "1 skill selected")
                            : `${skillIds.length} skills selected`}
                      </ComboboxTrigger>
                      <ComboboxPopup anchor={skillsTriggerRef} className="w-(--anchor-width)">
                        <ComboboxSearchInput
                          placeholder="Search skills…"
                          aria-label="Search skills"
                        />
                        <ComboboxEmpty>No skills found.</ComboboxEmpty>
                        <ComboboxList>
                          {(id: string) => {
                            const skill = skillOptions.find((item) => item.id === id);
                            return (
                              <ComboboxItem key={id} value={id}>
                                <div className="flex items-start gap-2">
                                  <CheckIcon
                                    aria-hidden
                                    className={`mt-0.5 size-4 shrink-0 ${skillIds.includes(id) ? "" : "invisible"}`}
                                  />
                                  <div className="min-w-0">
                                    <div className="break-words">{skill?.name ?? id}</div>
                                    {skill?.description && (
                                      <div className="text-xs text-muted-foreground line-clamp-2">
                                        {skill.description}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </ComboboxItem>
                            );
                          }}
                        </ComboboxList>
                      </ComboboxPopup>
                    </Combobox>
                  )}
                  <div className="mt-3 flex items-center gap-2 text-sm">
                    <Switch
                      id="agent-include-user-skills"
                      checked={includeUserSkills}
                      onCheckedChange={(checked) => setIncludeUserSkills(Boolean(checked))}
                    />
                    <label htmlFor="agent-include-user-skills">Include my global skills</label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    When off, the agent sees only its assigned skills plus built-in, project, and
                    plugin skills. On Codex, $skill won’t work for global skills. Supported on
                    Claude and Codex.
                  </p>
                </fieldset>
                <div className="agent-form-grid">
                  <label>
                    Thinking
                    <input
                      placeholder="Provider default"
                      list="agent-thinking"
                      value={thinking}
                      onChange={(e) => setThinking(e.target.value)}
                    />
                    <datalist id="agent-thinking">
                      {["minimal", "low", "medium", "high", "xhigh", "max"].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </datalist>
                  </label>
                  <label>
                    Permission mode
                    <select
                      value={runtimeMode}
                      onChange={(e) =>
                        setRuntimeMode(e.target.value as McpGatewayProfile["runtimeMode"])
                      }
                    >
                      {Object.entries(MCP_GATEWAY_RUNTIME_MODE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Interaction
                    <select
                      value={interactionMode}
                      onChange={(e) =>
                        setInteractionMode(e.target.value as McpGatewayProfile["interactionMode"])
                      }
                    >
                      <option value="default">Default</option>
                      <option value="plan">Plan</option>
                    </select>
                  </label>
                </div>
                <fieldset>
                  <legend>
                    Machines{" "}
                    <span className="text-muted-foreground">· none selected means any</span>
                  </legend>
                  <div className="agent-machines">
                    {machines.map((machine) => (
                      <label key={machine.environmentId}>
                        <input
                          type="checkbox"
                          checked={environmentIds.includes(machine.environmentId)}
                          onChange={(e) =>
                            setEnvironmentIds(
                              e.target.checked
                                ? [...environmentIds, machine.environmentId]
                                : environmentIds.filter((id) => id !== machine.environmentId),
                            )
                          }
                        />
                        {machine.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </details>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <footer>
              {onBack && (
                <button type="button" className="mr-auto" onClick={onBack} disabled={saving}>
                  Back
                </button>
              )}
              <button type="button" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button
                className="agent-primary"
                disabled={saving || !name.trim() || !provider || !selectedModel}
              >
                {saving ? "Saving…" : profile ? "Save agent" : "Create agent"}
              </button>
            </footer>
          </form>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
