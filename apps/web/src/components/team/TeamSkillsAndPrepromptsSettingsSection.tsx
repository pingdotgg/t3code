import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canManageTeamPreprompts,
  canManageTeamSkills,
  ProviderDriverKind,
  type EnvironmentId,
  type TeamAssetProviderDriver,
  type TeamMember,
  type TeamMemberId,
  type TeamPreprompt,
  type TeamPrepromptId,
  type TeamPrepromptInjectionScope,
  type TeamSkill,
  type TeamSkillId,
  type TeamSkillReference,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { BookOpenIcon, FileTextIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { m } from "~/i18n/messages";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { confirmTeamDestructiveAction } from "./confirmTeamDestructiveAction";
import {
  formatTeamDriverLabel,
  formatTeamPrepromptScopeLabel,
  getTeamAssetDriverOptions,
} from "./teamProviderDrivers";

const CODEX_ADDITIONAL_CONTEXT_BYTE_LIMIT = 4_000;
const utf8Encoder = new TextEncoder();

interface EditableSkillReference extends TeamSkillReference {
  readonly key: string;
}

let nextSkillRefKey = 1;
function toEditableSkillRef(ref: TeamSkillReference): EditableSkillReference {
  const key = `ref-${nextSkillRefKey++}`;
  return { ...ref, key };
}

function toAssetProviderDriver(value: string): TeamAssetProviderDriver {
  return value === "*" ? "*" : ProviderDriverKind.make(value);
}

export function TeamSkillsAndPrepromptsSettingsSection({
  environmentId,
  currentMember,
  memberById,
  skills,
  preprompts,
  assetsRevision,
}: {
  readonly environmentId: EnvironmentId;
  readonly currentMember: TeamMember | null;
  readonly memberById: ReadonlyMap<TeamMemberId, TeamMember>;
  readonly skills: ReadonlyArray<TeamSkill>;
  readonly preprompts: ReadonlyArray<TeamPreprompt>;
  readonly assetsRevision: number;
}) {
  const gt = useGT();
  const assetDriverOptions = getTeamAssetDriverOptions(gt);
  const canManageSkillsScope = useAtomValue(
    teamEnvironment.upsertSkill.permissionAtom(environmentId),
  );
  const canManagePrepromptsScope = useAtomValue(
    teamEnvironment.upsertPreprompt.permissionAtom(environmentId),
  );
  const canEditSkills =
    canManageSkillsScope &&
    currentMember !== null &&
    currentMember.status === "active" &&
    canManageTeamSkills(currentMember.role);
  const canEditPreprompts =
    canManagePrepromptsScope &&
    currentMember !== null &&
    currentMember.status === "active" &&
    canManageTeamPreprompts(currentMember.role);

  const runUpsertSkill = useAtomCommand(teamEnvironment.upsertSkill, { reportFailure: false });
  const runDeleteSkill = useAtomCommand(teamEnvironment.deleteSkill, { reportFailure: false });
  const runUpsertPreprompt = useAtomCommand(teamEnvironment.upsertPreprompt, {
    reportFailure: false,
  });
  const runDeletePreprompt = useAtomCommand(teamEnvironment.deletePreprompt, {
    reportFailure: false,
  });

  // Skill form state
  const [showSkillForm, setShowSkillForm] = useState(false);
  const [editingSkillId, setEditingSkillId] = useState<TeamSkillId | null>(null);
  const [skillSlug, setSkillSlug] = useState("");
  const [skillDriver, setSkillDriver] = useState("*");
  const [skillMd, setSkillMd] = useState(
    "---\nname: my-team-skill\ndescription: Describe when the agent should use this skill.\n---\n\n# Instructions\n",
  );
  const [skillRefs, setSkillRefs] = useState<ReadonlyArray<EditableSkillReference>>([]);
  const [skillEnabled, setSkillEnabled] = useState(true);
  const [savingSkill, setSavingSkill] = useState(false);
  const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null);

  // Pre-prompt form state
  const [showPrepromptForm, setShowPrepromptForm] = useState(false);
  const [editingPrepromptId, setEditingPrepromptId] = useState<TeamPrepromptId | null>(null);
  const [prepromptName, setPrepromptName] = useState("");
  const [prepromptDriver, setPrepromptDriver] = useState("*");
  const [prepromptScope, setPrepromptScope] = useState<TeamPrepromptInjectionScope>("thread");
  const [prepromptContent, setPrepromptContent] = useState("");
  const [prepromptEnabled, setPrepromptEnabled] = useState(true);
  const [savingPreprompt, setSavingPreprompt] = useState(false);
  const [deletingPrepromptId, setDeletingPrepromptId] = useState<string | null>(null);

  const prepromptByteLength = utf8Encoder.encode(prepromptContent).byteLength;
  const appliesToCodexTurnCap =
    prepromptScope === "turn" && (prepromptDriver === "*" || prepromptDriver === "codex");
  const exceedsCodexTurnCap =
    appliesToCodexTurnCap && prepromptByteLength > CODEX_ADDITIONAL_CONTEXT_BYTE_LIMIT;

  const reportError = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? title,
    });
  };

  const resetSkillForm = (closeForm = true) => {
    setEditingSkillId(null);
    setSkillSlug("");
    setSkillDriver("*");
    setSkillMd(
      "---\nname: my-team-skill\ndescription: Describe when the agent should use this skill.\n---\n\n# Instructions\n",
    );
    setSkillRefs([]);
    setSkillEnabled(true);
    if (closeForm) setShowSkillForm(false);
  };

  const resetPrepromptForm = (closeForm = true) => {
    setEditingPrepromptId(null);
    setPrepromptName("");
    setPrepromptDriver("*");
    setPrepromptScope("thread");
    setPrepromptContent("");
    setPrepromptEnabled(true);
    if (closeForm) setShowPrepromptForm(false);
  };

  const handleSaveSkill = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedSlug = skillSlug.trim().toLowerCase();
    if (trimmedSlug.length === 0) {
      reportError(gt("Could not save team skill"), new Error(gt("Enter a skill slug.")));
      return;
    }
    setSavingSkill(true);
    const result = await runUpsertSkill({
      environmentId,
      input: {
        ...(editingSkillId ? { skillId: editingSkillId } : {}),
        slug: trimmedSlug,
        providerDriver: toAssetProviderDriver(skillDriver),
        skillMd,
        references: skillRefs
          .filter((ref) => ref.path.trim().length > 0)
          .map(({ path, content }) => ({ path, content })),
        enabled: skillEnabled,
      },
    });
    setSavingSkill(false);
    if (result._tag === "Success") {
      resetSkillForm(true);
      toastManager.add({
        type: "success",
        title: gt("Team skill saved"),
        description: `/${result.value.slug} (rev ${result.value.revision})`,
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not save team skill"), squashAtomCommandFailure(result));
    }
  };

  const handleDeleteSkill = async (skill: TeamSkill) => {
    const confirmed = await confirmTeamDestructiveAction(
      [
        gt('Delete team skill "/{slug}"?', { slug: skill.slug }),
        gt("This removes the skill from all teammates' isolated team profiles on next sync."),
      ].join("\n"),
    );
    if (!confirmed) return;

    setDeletingSkillId(skill.id);
    const result = await runDeleteSkill({ environmentId, input: { skillId: skill.id } });
    setDeletingSkillId(null);
    if (result._tag === "Success") {
      if (editingSkillId === skill.id) resetSkillForm(true);
      toastManager.add({ type: "success", title: gt("Team skill deleted") });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not delete team skill"), squashAtomCommandFailure(result));
    }
  };

  const handleSavePreprompt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (prepromptName.trim().length === 0 || prepromptContent.trim().length === 0) {
      reportError(
        gt("Could not save team pre-prompt"),
        new Error(gt("Enter both a name and instruction text.")),
      );
      return;
    }
    setSavingPreprompt(true);
    const result = await runUpsertPreprompt({
      environmentId,
      input: {
        ...(editingPrepromptId ? { prepromptId: editingPrepromptId } : {}),
        name: prepromptName.trim(),
        providerDriver: toAssetProviderDriver(prepromptDriver),
        injectionScope: prepromptScope,
        content: prepromptContent,
        enabled: prepromptEnabled,
      },
    });
    setSavingPreprompt(false);
    if (result._tag === "Success") {
      resetPrepromptForm(true);
      toastManager.add({
        type: "success",
        title: gt("Team pre-prompt saved"),
        description: `${result.value.name} (${formatTeamPrepromptScopeLabel(result.value.injectionScope, gt)})`,
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not save team pre-prompt"), squashAtomCommandFailure(result));
    }
  };

  const handleDeletePreprompt = async (preprompt: TeamPreprompt) => {
    const confirmed = await confirmTeamDestructiveAction(
      [
        gt('Delete team pre-prompt "{name}"?', { name: preprompt.name }),
        gt("This instruction will no longer be injected into team threads."),
      ].join("\n"),
    );
    if (!confirmed) return;

    setDeletingPrepromptId(preprompt.id);
    const result = await runDeletePreprompt({
      environmentId,
      input: { prepromptId: preprompt.id },
    });
    setDeletingPrepromptId(null);
    if (result._tag === "Success") {
      if (editingPrepromptId === preprompt.id) resetPrepromptForm(true);
      toastManager.add({ type: "success", title: gt("Team pre-prompt deleted") });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not delete team pre-prompt"), squashAtomCommandFailure(result));
    }
  };

  return (
    <>
      <SettingsSection
        id="teams-skills"
        title={gt("Team skills")}
        icon={<FileTextIcon className="size-4" />}
        headerAction={
          canEditSkills && !showSkillForm ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-testid="team-skill-add-open"
              onClick={() => {
                resetSkillForm(false);
                setShowSkillForm(true);
              }}
            >
              <PlusIcon />
              <T>Add skill</T>
            </Button>
          ) : undefined
        }
      >
        <SettingsRow
          title={gt("Pure Markdown skills (rev {revision})", { revision: assetsRevision })}
          description={gt(
            "Shared skills sync automatically into teammates' isolated team profiles without touching personal ~/.gemini, ~/.codex, or ~/.claude directories. Executable scripts and binaries are rejected.",
          )}
        >
          <div className="mt-2 space-y-2 pb-3" data-testid="team-skills-list">
            {skills.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No team skills published yet.</T>
              </p>
            ) : (
              skills.map((skill) => {
                const updater = memberById.get(skill.updatedByMemberId)?.pseudo ?? "member";
                return (
                  <div
                    key={skill.id}
                    data-testid={`team-skill-row-${skill.slug}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-sm font-medium">/{skill.slug}</span>
                        <Badge variant="outline" size="sm">
                          {formatTeamDriverLabel(skill.providerDriver, gt)}
                        </Badge>
                        {!skill.enabled ? (
                          <Badge variant="secondary" size="sm">
                            <T>Disabled</T>
                          </Badge>
                        ) : null}
                        {skill.references.length > 0 ? (
                          <Badge variant="outline" size="sm">
                            {gt("{count} refs", { count: skill.references.length })}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {gt("Rev {revision} · Updated by {pseudo}", {
                          revision: skill.revision,
                          pseudo: updater,
                        })}
                      </p>
                    </div>
                    {canEditSkills ? (
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => {
                            setEditingSkillId(skill.id);
                            setSkillSlug(skill.slug);
                            setSkillDriver(skill.providerDriver);
                            setSkillMd(skill.skillMd);
                            setSkillRefs(skill.references.map(toEditableSkillRef));
                            setSkillEnabled(skill.enabled);
                            setShowSkillForm(true);
                          }}
                        >
                          <T>Edit</T>
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={deletingSkillId === skill.id}
                          onClick={() => void handleDeleteSkill(skill)}
                          data-testid={`team-skill-delete-${skill.slug}`}
                        >
                          <Trash2Icon />
                          <T>Delete</T>
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </SettingsRow>

        {canEditSkills && showSkillForm ? (
          <SettingsRow
            title={editingSkillId ? gt("Edit team skill") : gt("Create team skill")}
            description={gt(
              "Provide SKILL.md with YAML frontmatter (name & description) plus optional Markdown/text reference files.",
            )}
          >
            <form
              className="mt-2 space-y-3 pb-3"
              onSubmit={(event) => void handleSaveSkill(event)}
              data-testid="team-skill-form"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-muted-foreground"
                    htmlFor="team-skill-slug"
                  >
                    <T>Skill slug</T>
                  </label>
                  <Input
                    id="team-skill-slug"
                    data-testid="team-skill-slug-input"
                    value={skillSlug}
                    onChange={(event) => setSkillSlug(event.currentTarget.value)}
                    placeholder="pr-review"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-muted-foreground"
                    htmlFor="team-skill-driver"
                  >
                    <T>Provider scope</T>
                  </label>
                  <Select
                    value={skillDriver}
                    onValueChange={(value) => {
                      if (value) setSkillDriver(value);
                    }}
                  >
                    <SelectTrigger id="team-skill-driver" data-testid="team-skill-driver-select">
                      <SelectValue>{formatTeamDriverLabel(skillDriver, gt)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {assetDriverOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>

              <div className="space-y-1">
                <label
                  className="block text-xs font-medium text-muted-foreground"
                  htmlFor="team-skill-md"
                >
                  {/* oxlint-disable-next-line t3code/no-untranslated-copy -- Exact required filename. */}
                  SKILL.md
                </label>
                <Textarea
                  id="team-skill-md"
                  rows={6}
                  data-testid="team-skill-md-input"
                  value={skillMd}
                  onChange={(event) => setSkillMd(event.currentTarget.value)}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">
                    <T>Reference files (Markdown/text only)</T>
                  </p>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      setSkillRefs((prev) => [
                        ...prev,
                        toEditableSkillRef({
                          path: `references/guide-${prev.length + 1}.md`,
                          content: "",
                        }),
                      ])
                    }
                  >
                    <PlusIcon className="size-3" />
                    <T>Add reference</T>
                  </Button>
                </div>
                {skillRefs.map((ref) => (
                  <div key={ref.key} className="space-y-1.5 rounded-md border border-border/60 p-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={ref.path}
                        aria-label={gt("Reference file path")}
                        onChange={(event) => {
                          const nextPath = event.currentTarget.value;
                          setSkillRefs((prev) =>
                            prev.map((item) =>
                              item.key === ref.key ? { ...item, path: nextPath } : item,
                            ),
                          );
                        }}
                        placeholder="references/checklist.md"
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        aria-label={gt("Remove reference file {path}", {
                          path: ref.path || gt("untitled"),
                        })}
                        onClick={() =>
                          setSkillRefs((prev) => prev.filter((item) => item.key !== ref.key))
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    <Textarea
                      rows={3}
                      value={ref.content}
                      aria-label={gt("Reference file contents for {path}", {
                        path: ref.path || gt("untitled"),
                      })}
                      onChange={(event) => {
                        const nextContent = event.currentTarget.value;
                        setSkillRefs((prev) =>
                          prev.map((item) =>
                            item.key === ref.key ? { ...item, content: nextContent } : item,
                          ),
                        );
                      }}
                      placeholder="# Reference notes"
                    />
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={skillEnabled} onCheckedChange={setSkillEnabled} />
                  <span>
                    <T>Enabled</T>
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => resetSkillForm(true)}
                  >
                    <T>Cancel</T>
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={savingSkill}
                    data-testid="team-skill-save-submit"
                  >
                    {savingSkill ? <Spinner className="size-3.5" /> : null}
                    <T>Save skill</T>
                  </Button>
                </div>
              </div>
            </form>
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <SettingsSection
        id="teams-preprompts"
        title={gt("Team pre-prompts")}
        icon={<BookOpenIcon className="size-4" />}
        headerAction={
          canEditPreprompts && !showPrepromptForm ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-testid="team-preprompt-add-open"
              onClick={() => {
                resetPrepromptForm(false);
                setShowPrepromptForm(true);
              }}
            >
              <PlusIcon />
              <T>Add pre-prompt</T>
            </Button>
          ) : undefined
        }
      >
        <SettingsRow
          title={gt("Thread & per-turn instructions")}
          description={gt(
            "Thread pre-prompts materialize once into isolated team profiles (prefix-cached, zero per-turn overhead). Turn pre-prompts re-inject on every turn so critical rules survive compaction.",
          )}
        >
          <div className="mt-2 space-y-2 pb-3" data-testid="team-preprompts-list">
            {preprompts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No team pre-prompts configured yet.</T>
              </p>
            ) : (
              preprompts.map((preprompt) => {
                const updater = memberById.get(preprompt.updatedByMemberId)?.pseudo ?? "member";
                return (
                  <div
                    key={preprompt.id}
                    data-testid={`team-preprompt-row-${preprompt.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">{preprompt.name}</span>
                        <Badge
                          variant={preprompt.injectionScope === "turn" ? "info" : "outline"}
                          size="sm"
                        >
                          {preprompt.injectionScope === "turn"
                            ? gt("Every turn")
                            : gt("Thread start")}
                        </Badge>
                        <Badge variant="outline" size="sm">
                          {formatTeamDriverLabel(preprompt.providerDriver, gt)}
                        </Badge>
                        {!preprompt.enabled ? (
                          <Badge variant="secondary" size="sm">
                            <T>Disabled</T>
                          </Badge>
                        ) : null}
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {preprompt.content}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {gt("Rev {revision} · Updated by {pseudo}", {
                          revision: preprompt.revision,
                          pseudo: updater,
                        })}
                      </p>
                    </div>
                    {canEditPreprompts ? (
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => {
                            setEditingPrepromptId(preprompt.id);
                            setPrepromptName(preprompt.name);
                            setPrepromptDriver(preprompt.providerDriver);
                            setPrepromptScope(preprompt.injectionScope);
                            setPrepromptContent(preprompt.content);
                            setPrepromptEnabled(preprompt.enabled);
                            setShowPrepromptForm(true);
                          }}
                        >
                          <T>Edit</T>
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={deletingPrepromptId === preprompt.id}
                          onClick={() => void handleDeletePreprompt(preprompt)}
                          data-testid={`team-preprompt-delete-${preprompt.id}`}
                        >
                          <Trash2Icon />
                          <T>Delete</T>
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </SettingsRow>

        {canEditPreprompts && showPrepromptForm ? (
          <SettingsRow
            title={editingPrepromptId ? gt("Edit team pre-prompt") : gt("Create team pre-prompt")}
            description={gt(
              "Choose 'Thread start' for general coding guidelines or 'Every turn' for short mandatory rules that must survive long sessions.",
            )}
          >
            <form
              className="mt-2 space-y-3 pb-3"
              onSubmit={(event) => void handleSavePreprompt(event)}
              data-testid="team-preprompt-form"
            >
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-muted-foreground"
                    htmlFor="team-preprompt-name"
                  >
                    <T>Name</T>
                  </label>
                  <Input
                    id="team-preprompt-name"
                    data-testid="team-preprompt-name-input"
                    value={prepromptName}
                    onChange={(event) => setPrepromptName(event.currentTarget.value)}
                    placeholder={gt("Safety guardrails")}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-muted-foreground"
                    htmlFor="team-preprompt-driver"
                  >
                    <T>Provider scope</T>
                  </label>
                  <Select
                    value={prepromptDriver}
                    onValueChange={(value) => {
                      if (value) setPrepromptDriver(value);
                    }}
                  >
                    <SelectTrigger
                      id="team-preprompt-driver"
                      data-testid="team-preprompt-driver-select"
                    >
                      <SelectValue>{formatTeamDriverLabel(prepromptDriver, gt)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {assetDriverOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-muted-foreground"
                    htmlFor="team-preprompt-scope"
                  >
                    <T>Injection scope</T>
                  </label>
                  <Select
                    value={prepromptScope}
                    onValueChange={(value) => {
                      if (value === "thread" || value === "turn") {
                        setPrepromptScope(value);
                      }
                    }}
                  >
                    <SelectTrigger
                      id="team-preprompt-scope"
                      data-testid="team-preprompt-scope-select"
                    >
                      <SelectValue>{formatTeamPrepromptScopeLabel(prepromptScope, gt)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="thread">
                        {formatTeamPrepromptScopeLabel("thread", gt)}
                      </SelectItem>
                      <SelectItem value="turn">
                        {formatTeamPrepromptScopeLabel("turn", gt)}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    className="block text-xs font-medium text-muted-foreground"
                    htmlFor="team-preprompt-content"
                  >
                    <T>Instruction text</T>
                  </label>
                  {appliesToCodexTurnCap ? (
                    <span
                      className={
                        exceedsCodexTurnCap
                          ? "text-2xs font-medium text-warning-foreground"
                          : "text-2xs text-muted-foreground"
                      }
                      data-testid="team-preprompt-codex-size-hint"
                    >
                      {gt("{bytes} / 4,000 bytes (Codex per-turn limit)", {
                        bytes: prepromptByteLength,
                      })}
                    </span>
                  ) : null}
                </div>
                <Textarea
                  id="team-preprompt-content"
                  rows={5}
                  data-testid="team-preprompt-content-input"
                  value={prepromptContent}
                  onChange={(event) => setPrepromptContent(event.currentTarget.value)}
                  placeholder={gt("Always run unit tests before declaring work complete.")}
                />
                {appliesToCodexTurnCap ? (
                  <p className="text-2xs text-muted-foreground">
                    <T>
                      Codex truncates per-turn additional context entries past 4,000 bytes. Keep
                      every-turn rules concise or use Thread start for longer documentation.
                    </T>
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={prepromptEnabled} onCheckedChange={setPrepromptEnabled} />
                  <span>
                    <T>Enabled</T>
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => resetPrepromptForm(true)}
                  >
                    <T>Cancel</T>
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={savingPreprompt}
                    data-testid="team-preprompt-save-submit"
                  >
                    {savingPreprompt ? <Spinner className="size-3.5" /> : null}
                    <T>Save pre-prompt</T>
                  </Button>
                </div>
              </div>
            </form>
          </SettingsRow>
        ) : null}
      </SettingsSection>
    </>
  );
}
