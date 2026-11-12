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
import {
  Select,
  SelectButton,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Alert, AlertDescription } from "../ui/alert";
import { agentModelOptions, presetProviderLabel } from "./agentModelCatalog";
import type { AgentSkill, McpGatewayProfile, ServerProvider } from "@t3tools/contracts";
import { MCP_GATEWAY_RUNTIME_MODE_LABELS } from "@t3tools/contracts";
import { agentColors, defaultAgentColor, soleOption } from "./agents.logic";
import {
  agentIconFieldsToSave,
  normalizeAgentTags,
  resolveAgentIconId,
  type AgentIconId,
} from "@t3tools/client-runtime/state/agentIdentity";
import { AgentIconPicker } from "./AgentIconPicker";
import { AgentTagsField } from "./AgentTagsField";
import { AGENT_PRESET_SETUP_NOTE } from "./AgentPresetPicker";
import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { randomUUID } from "../../lib/utils";
import {
  findIdenticalSkill,
  type AgentPreset,
  type AgentPresetSkill,
} from "@t3tools/shared/agentPresets";

const emptySkills: ReadonlyArray<AgentSkill> = [];
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 border-t pt-6 first:border-t-0 first:pt-0"
    >
      <h3 id={id} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Label over control, with an optional hint under it. */
function FormField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
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
  const ids = useId();
  const providerOptions = [...new Set([...providerLabels, ...(provider ? [provider] : [])])];
  const modelItems = [
    ...(model && !selectedModel
      ? [{ value: model, label: `${model}: unavailable; select a model`, disabled: true }]
      : []),
    ...models.map((option) => ({
      value: option.slug,
      label: `${option.name} (${option.slug})`,
      disabled: false,
    })),
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <form
          className="flex min-h-0 flex-col"
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
          <DialogHeader>
            <DialogTitle>
              {profile
                ? "Edit agent"
                : preset
                  ? `Create agent from ${preset.name}`
                  : "Create agent"}
            </DialogTitle>
            <DialogDescription>
              Name a specialist and choose its model. It starts working when you give it a task.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-6">
              {preset && (
                <Alert variant="info" role="note">
                  <AlertDescription>
                    <p>{AGENT_PRESET_SETUP_NOTE}</p>
                    {preset.setupNotes.length > 0 && (
                      <ul className="mt-1 list-disc ps-4">
                        {preset.setupNotes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    )}
                    {!skillsAvailable && preset.skills.length > 0 && (
                      <p className="mt-1">
                        Update T3 Code on this machine to add this preset’s skills.
                      </p>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              <FormSection title="Identity">
                <div
                  className="flex items-end gap-3"
                  style={{ "--agent-color": color } as CSSProperties}
                >
                  <AgentIconPicker value={iconId} onChange={setPickedIcon} />
                  <div className="min-w-0 flex-1">
                    <FormField label="Name" htmlFor={`${ids}-name`}>
                      <Input
                        id={`${ids}-name`}
                        autoFocus
                        required
                        maxLength={200}
                        placeholder="Write, Review, Research…"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </FormField>
                  </div>
                </div>
                <FormField
                  label="Specialization"
                  htmlFor={`${ids}-description`}
                  hint="A short description shown on the board and in MCP."
                >
                  <Input
                    id={`${ids}-description`}
                    maxLength={280}
                    placeholder="Reviews code for correctness, security, and maintainability"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </FormField>
                <AgentTagsField tags={tags} onChange={setTags} />
                <fieldset>
                  <Label render={<legend />} className="mb-1.5">
                    Color
                  </Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="color"
                      aria-label="Custom color"
                      className="h-7 w-10 cursor-pointer rounded-md border bg-background p-0.5"
                      value={color}
                      onChange={(event) => setColor(event.target.value)}
                    />
                    {agentColors.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-label={`Use color ${value}`}
                        aria-pressed={color === value}
                        className="size-6 cursor-pointer rounded-full aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-inset"
                        style={{ background: value }}
                        onClick={() => setColor(value)}
                      />
                    ))}
                  </div>
                </fieldset>
              </FormSection>
              <FormSection title="Model and modes">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FormField label="Provider" htmlFor={`${ids}-provider`}>
                    <Select
                      value={provider || null}
                      onValueChange={(value) => {
                        if (value === null) return;
                        setProviderLabel(value);
                        setModelLabel("");
                      }}
                    >
                      <SelectTrigger id={`${ids}-provider`}>
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectPopup>
                        {providerOptions.map((label) => (
                          <SelectItem key={label} value={label}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </FormField>
                  <FormField label="Model" htmlFor={`${ids}-model`}>
                    <Select
                      items={modelItems}
                      value={(selectedModel?.slug ?? model) || null}
                      onValueChange={(value) => {
                        if (value !== null) setModelLabel(value);
                      }}
                    >
                      <SelectTrigger id={`${ids}-model`}>
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectPopup>
                        {modelItems.map((item) => (
                          <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </FormField>
                </div>
                {preset && model === preset.model.model && !selectedModel && (
                  <p role="alert" className="text-sm text-warning">
                    {providerLabels.includes(provider)
                      ? `${model} isn’t available from ${provider}.`
                      : `${provider} isn’t installed on a connected machine.`}{" "}
                    Choose an available provider and model to save this agent.
                  </p>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <FormField label="Thinking" htmlFor={`${ids}-thinking`}>
                    <Input
                      id={`${ids}-thinking`}
                      placeholder="Provider default"
                      list={`${ids}-thinking-levels`}
                      value={thinking}
                      onChange={(e) => setThinking(e.target.value)}
                    />
                    <datalist id={`${ids}-thinking-levels`}>
                      {THINKING_LEVELS.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </datalist>
                  </FormField>
                  <FormField label="Permission mode" htmlFor={`${ids}-runtime`}>
                    <Select
                      items={MCP_GATEWAY_RUNTIME_MODE_LABELS}
                      value={runtimeMode}
                      onValueChange={(value) => {
                        if (value !== null) setRuntimeMode(value);
                      }}
                    >
                      <SelectTrigger id={`${ids}-runtime`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {Object.entries(MCP_GATEWAY_RUNTIME_MODE_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </FormField>
                  <FormField label="Interaction" htmlFor={`${ids}-interaction`}>
                    <Select
                      items={{ default: "Default", plan: "Plan" }}
                      value={interactionMode}
                      onValueChange={(value) => {
                        if (value !== null) setInteractionMode(value);
                      }}
                    >
                      <SelectTrigger id={`${ids}-interaction`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="default">Default</SelectItem>
                        <SelectItem value="plan">Plan</SelectItem>
                      </SelectPopup>
                    </Select>
                  </FormField>
                </div>
                <fieldset>
                  <Label render={<legend />} className="mb-1.5">
                    Machines
                    <span className="font-normal text-muted-foreground">
                      none selected means any
                    </span>
                  </Label>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {machines.map((machine) => (
                      <Label key={machine.environmentId}>
                        <Checkbox
                          checked={environmentIds.includes(machine.environmentId)}
                          onCheckedChange={(checked) =>
                            setEnvironmentIds(
                              checked
                                ? [...environmentIds, machine.environmentId]
                                : environmentIds.filter((id) => id !== machine.environmentId),
                            )
                          }
                        />
                        {machine.label}
                      </Label>
                    ))}
                  </div>
                </fieldset>
              </FormSection>
              <FormSection title="Instructions">
                <FormField
                  label="System prompt"
                  htmlFor={`${ids}-prompt`}
                  hint="Agent configuration and skill changes apply to new chats. Existing chats keep their starting configuration."
                >
                  <Textarea
                    id={`${ids}-prompt`}
                    rows={8}
                    maxLength={32000}
                    className="max-h-80"
                    value={systemPrompt}
                    onChange={(event) => setSystemPrompt(event.target.value)}
                    placeholder="Describe this agent’s role, workflow, and expected output…"
                  />
                </FormField>
              </FormSection>
              <FormSection title="Skills">
                {skillOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Add reusable skills from the Agents board.
                  </p>
                ) : (
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
                      render={<SelectButton />}
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
                <div className="flex flex-col gap-1.5">
                  <Label>
                    <Switch
                      checked={includeUserSkills}
                      onCheckedChange={(checked) => setIncludeUserSkills(Boolean(checked))}
                    />
                    Include my global skills
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    When off, the agent sees only its assigned skills plus built-in, project, and
                    plugin skills. On Codex, $skill won’t work for global skills. Supported on
                    Claude and Codex.
                  </p>
                </div>
              </FormSection>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            {onBack && (
              <Button
                type="button"
                variant="ghost"
                className="sm:me-auto"
                onClick={onBack}
                disabled={saving}
              >
                Back
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim() || !provider || !selectedModel}>
              {saving ? "Saving…" : profile ? "Save agent" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
