import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpenIcon, RefreshCcwIcon } from "lucide-react";
import { useState } from "react";

import { useAppSettings } from "~/appSettings";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import ChatMarkdown from "~/components/ChatMarkdown";
import { Input } from "~/components/ui/input";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { Spinner } from "~/components/ui/spinner";
import {
  initializeSharedSkillsMutationOptions,
  sharedSkillDetailQueryOptions,
  sharedSkillsQueryOptions,
  setSharedSkillEnabledMutationOptions,
  uninstallSharedSkillMutationOptions,
} from "~/lib/sharedSkillsReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { openInPreferredEditor } from "~/editorPreferences";

const STATUS_LABEL_BY_SKILL_STATE = {
  managed: "Managed",
  "needs-migration": "Needs migration",
  "needs-link": "Disabled in Codex",
  conflict: "Needs review",
  "broken-link": "Broken link",
} as const;

interface SkillsSettingsPanelProps {
  codexHomePath: string;
}

function inferHomePath(codexHomePath: string) {
  if (codexHomePath.endsWith("/.codex")) {
    return codexHomePath.slice(0, -"/.codex".length);
  }

  return null;
}

function toDisplayPath(value: string, codexHomePath: string) {
  const homePath = inferHomePath(codexHomePath);
  if (!homePath) {
    return value;
  }

  if (value === homePath) {
    return "~";
  }

  if (value.startsWith(`${homePath}/`)) {
    return `~/${value.slice(homePath.length + 1)}`;
  }

  return value;
}

function skillDisplayName(skill: {
  displayName?: string | null | undefined;
  name: string;
  shortDescription?: string | null | undefined;
  description?: string | null | undefined;
}) {
  const fallbackName = skill.name.match(/[^/]+$/)?.[0] ?? skill.name;
  return {
    name: skill.displayName || fallbackName,
    description: skill.shortDescription || skill.description || null,
  };
}

function skillMonogram(name: string) {
  return name
    .split(/[\s-_]+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function SkillTile({
  brandColor,
  label,
}: {
  brandColor?: string | null | undefined;
  label: string;
}) {
  const style = brandColor
    ? {
        backgroundColor: `${brandColor}22`,
        borderColor: `${brandColor}44`,
        color: brandColor,
      }
    : undefined;

  return (
    <div
      className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-xs font-semibold text-foreground"
      style={style}
    >
      {skillMonogram(label)}
    </div>
  );
}

export function SkillsSettingsPanel({ codexHomePath }: SkillsSettingsPanelProps) {
  const { settings, updateSettings } = useAppSettings();
  const queryClient = useQueryClient();
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [openFolderError, setOpenFolderError] = useState<string | null>(null);
  const config = {
    codexHomePath,
    sharedSkillsPath: settings.sharedSkillsPath,
  };

  const sharedSkillsQuery = useQuery(sharedSkillsQueryOptions(config, !isEditingPath));
  const selectedSkillQuery = useQuery(
    sharedSkillDetailQueryOptions(config, selectedSkillName, selectedSkillName !== null),
  );

  const initializeMutation = useMutation(
    initializeSharedSkillsMutationOptions({
      config,
      queryClient,
    }),
  );
  const setEnabledMutation = useMutation({
    ...setSharedSkillEnabledMutationOptions({
      config,
      queryClient,
    }),
  });
  const uninstallMutation = useMutation(
    uninstallSharedSkillMutationOptions({
      config,
      queryClient,
    }),
  );

  const sharedSkillsState = sharedSkillsQuery.data;
  const sharedSkillsPath = settings.sharedSkillsPath;
  const selectedSkillDetail = selectedSkillQuery.data;
  const isInitialized = sharedSkillsState?.isInitialized === true;
  const pendingMigrationSkills =
    sharedSkillsState?.skills.filter((skill) => skill.status === "needs-migration") ?? [];
  const resolvedCodexHomePath = sharedSkillsState?.codexHomePath ?? codexHomePath;
  const queryError =
    sharedSkillsQuery.error instanceof Error
      ? sharedSkillsQuery.error.message
      : sharedSkillsQuery.error
        ? "Unable to inspect shared skills."
        : null;
  const initializeError =
    initializeMutation.error instanceof Error
      ? initializeMutation.error.message
      : initializeMutation.error
        ? "Unable to sync shared skills."
        : null;
  const actionError =
    (selectedSkillQuery.error instanceof Error && selectedSkillQuery.error.message) ||
    (setEnabledMutation.error instanceof Error && setEnabledMutation.error.message) ||
    (uninstallMutation.error instanceof Error && uninstallMutation.error.message) ||
    null;

  const resetActionErrors = () => {
    setEnabledMutation.reset();
    uninstallMutation.reset();
  };

  const selectSkill = (skillName: string) => {
    setOpenFolderError(null);
    resetActionErrors();
    setSelectedSkillName(skillName);
  };

  const openFolderPicker = async () => {
    const pickedPath = await ensureNativeApi().dialogs.pickFolder();
    if (!pickedPath) {
      return;
    }

    updateSettings({ sharedSkillsPath: pickedPath });
  };

  const handleToggleSelectedSkill = async (enabled: boolean) => {
    if (!selectedSkillDetail) {
      return;
    }

    setOpenFolderError(null);
    resetActionErrors();
    await setEnabledMutation.mutateAsync({
      enabled,
      skillName: selectedSkillDetail.skill.name,
    });
  };

  const handleUninstallSelectedSkill = async () => {
    if (!selectedSkillDetail) {
      return;
    }

    const confirmed = await ensureNativeApi().dialogs.confirm(
      [
        `Uninstall skill "${skillDisplayName(selectedSkillDetail.skill).name}"?`,
        "This permanently removes the shared skill directory.",
      ].join("\n"),
    );
    if (!confirmed) {
      return;
    }

    setOpenFolderError(null);
    resetActionErrors();
    await uninstallMutation.mutateAsync(selectedSkillDetail.skill.name);
    setSelectedSkillName((current) =>
      current === selectedSkillDetail.skill.name ? null : current,
    );
  };

  const handleOpenSharedSkillsFolder = async () => {
    try {
      setOpenFolderError(null);
      if (!sharedSkillsState?.sharedSkillsPath) {
        throw new Error("Shared skills folder is not available yet.");
      }

      await openInPreferredEditor(ensureNativeApi(), sharedSkillsState.sharedSkillsPath);
    } catch (error) {
      setOpenFolderError(
        error instanceof Error ? error.message : "Unable to open the shared skill folder.",
      );
    }
  };

  const userSkillsRoot = sharedSkillsState?.agentsSkillsPath ?? "~/.agents/skills";
  const codexSystemSkillsRoot = `${
    sharedSkillsState?.codexSkillsPath ?? `${codexHomePath || "~/.codex"}/skills`
  }/.system`;

  return (
    <>
      <div className="space-y-6">
        {!sharedSkillsState?.isInitialized ? (
          <Alert variant="warning">
            <AlertTitle>Initialize shared skill sync</AlertTitle>
            <AlertDescription>
              <p>
                The first run is explicit. Initializing moves user skill folders from{" "}
                <code>~/.agents/skills</code> into the shared directory, then symlinks them back so
                harnesses still see their normal paths.
              </p>
              <p>
                Codex system skills still live under <code>CODEX_HOME/skills/.system</code>.
                Reopening this tab surfaces newly discovered user skills here so you can move them
                into the shared directory explicitly.
              </p>
            </AlertDescription>
            <AlertAction>
              <Button
                disabled={initializeMutation.isPending || isEditingPath}
                onClick={() => initializeMutation.mutate()}
              >
                {initializeMutation.isPending ? <Spinner className="size-4" /> : null}
                Initialize
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {isInitialized && pendingMigrationSkills.length > 0 ? (
          <Alert variant="warning">
            <AlertTitle>
              {pendingMigrationSkills.length === 1
                ? "New skill found outside the shared directory"
                : "New skills found outside the shared directory"}
            </AlertTitle>
            <AlertDescription>
              {pendingMigrationSkills.length === 1
                ? "A newly installed skill is still living in a harness root. Move it into the shared directory to keep this setup in sync."
                : `${pendingMigrationSkills.length} newly installed skills are still living in harness roots. Move them into the shared directory to keep this setup in sync.`}
            </AlertDescription>
            <AlertAction>
              <Button
                disabled={initializeMutation.isPending || isEditingPath}
                onClick={() => initializeMutation.mutate()}
              >
                {initializeMutation.isPending ? <Spinner className="size-4" /> : null}
                {pendingMigrationSkills.length === 1 ? "Move skill" : "Move skills"}
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        <section className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-4">
            <h2 className="text-sm font-medium text-foreground">Shared Skills</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Keep user skills in one shared directory so other harnesses can point at the same
              source of truth later while Codex continues reading its normal user and system skill
              roots as usual.
            </p>
          </div>

          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <label htmlFor="shared-skills-path" className="block flex-1 space-y-1">
                <span className="text-xs font-medium text-foreground">Shared skills directory</span>
                <Input
                  id="shared-skills-path"
                  value={sharedSkillsPath}
                  onBlur={() => setIsEditingPath(false)}
                  onChange={(event) => updateSettings({ sharedSkillsPath: event.target.value })}
                  onFocus={() => setIsEditingPath(true)}
                  placeholder="~/Documents/skills"
                  spellCheck={false}
                />
                <span className="text-xs text-muted-foreground">
                  Leave blank to use <code>~/Documents/skills</code>.
                </span>
              </label>
              <Button className="sm:mt-6" variant="outline" onClick={() => void openFolderPicker()}>
                Choose folder
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-background px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">User skills root</p>
                <p className="mt-1 break-all font-mono text-xs text-foreground">
                  {toDisplayPath(userSkillsRoot, resolvedCodexHomePath)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-background px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">Codex system root</p>
                <p className="mt-1 break-all font-mono text-xs text-foreground">
                  {toDisplayPath(codexSystemSkillsRoot, resolvedCodexHomePath)}
                </p>
              </div>
            </div>
          </div>
        </section>

        {queryError ? (
          <Alert variant="error">
            <AlertTitle>Skills inspection failed</AlertTitle>
            <AlertDescription>{queryError}</AlertDescription>
          </Alert>
        ) : null}

        {initializeError ? (
          <Alert variant="error">
            <AlertTitle>Initialization failed</AlertTitle>
            <AlertDescription>{initializeError}</AlertDescription>
          </Alert>
        ) : null}

        {openFolderError ? (
          <Alert variant="error">
            <AlertTitle>Folder open failed</AlertTitle>
            <AlertDescription>{openFolderError}</AlertDescription>
          </Alert>
        ) : null}

        {sharedSkillsState?.warnings.length ? (
          <Alert variant="warning">
            <AlertTitle>Manual follow-up needed</AlertTitle>
            <AlertDescription>
              {sharedSkillsState.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </AlertDescription>
          </Alert>
        ) : null}

        <section className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium text-foreground">Managed skills</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Skills discovered in the current harness skill roots are tracked here.
              </p>
              {isInitialized ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Use <code>Recheck skills</code> after adding skills in the current source harness
                  to import and relink them here.
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={!sharedSkillsState?.sharedSkillsPath}
                onClick={() => void handleOpenSharedSkillsFolder()}
              >
                <FolderOpenIcon className="size-3.5" />
                Open folder
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={sharedSkillsQuery.isFetching || isEditingPath}
                onClick={() => void sharedSkillsQuery.refetch()}
              >
                {sharedSkillsQuery.isFetching ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <RefreshCcwIcon className="size-3.5" />
                )}
                {isInitialized ? "Recheck skills" : "Refresh"}
              </Button>
            </div>
          </div>

          {sharedSkillsQuery.isLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-4 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Inspecting shared skills...
            </div>
          ) : sharedSkillsState?.skills.length ? (
            <div className="space-y-3">
              {sharedSkillsState.skills.map((skill) => {
                const display = skillDisplayName(skill);
                return (
                  <button
                    key={skill.name}
                    type="button"
                    className="flex w-full items-start gap-3 rounded-lg border border-border bg-background px-4 py-3 text-left transition-colors hover:bg-accent/40"
                    onClick={() => selectSkill(skill.name)}
                  >
                    <SkillTile brandColor={skill.brandColor} label={display.name} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {display.name}
                        </span>
                        <Badge size="sm" variant={skill.enabled ? "success" : "outline"}>
                          {skill.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                      {display.description ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {display.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-[11px] text-muted-foreground">
                      {STATUS_LABEL_BY_SKILL_STATE[skill.status]}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-sm text-muted-foreground">
              <p>No skills were found yet.</p>
            </div>
          )}
        </section>
      </div>

      <Sheet
        onOpenChange={(open) => {
          if (!open) {
            resetActionErrors();
            setSelectedSkillName(null);
          }
        }}
        open={selectedSkillName !== null}
      >
        <SheetPopup side="right">
          <SheetHeader>
            {selectedSkillDetail ? (
              <div className="flex items-start gap-3">
                <SkillTile
                  brandColor={selectedSkillDetail.skill.brandColor}
                  label={skillDisplayName(selectedSkillDetail.skill).name}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <SheetTitle>{skillDisplayName(selectedSkillDetail.skill).name}</SheetTitle>
                    <Badge
                      size="sm"
                      variant={selectedSkillDetail.skill.enabled ? "success" : "outline"}
                    >
                      {selectedSkillDetail.skill.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </div>
                  <SheetDescription>
                    {skillDisplayName(selectedSkillDetail.skill).description ||
                      "No description available."}
                  </SheetDescription>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                Loading skill...
              </div>
            )}
          </SheetHeader>

          <SheetPanel className="flex min-h-full flex-col gap-4">
            {actionError ? (
              <Alert variant="error">
                <AlertTitle>Skill action failed</AlertTitle>
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            ) : null}

            {selectedSkillDetail && !isInitialized ? (
              <Alert variant="warning">
                <AlertTitle>Initialize before enabling</AlertTitle>
                <AlertDescription>
                  Initialize shared skill sync from the banner above before making this skill
                  visible to Codex.
                </AlertDescription>
              </Alert>
            ) : null}

            {selectedSkillDetail ? (
              <>
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  {isInitialized ? (
                    selectedSkillDetail.skill.enabled ? (
                      <Button
                        disabled={setEnabledMutation.isPending || uninstallMutation.isPending}
                        variant="outline"
                        onClick={() => void handleToggleSelectedSkill(false)}
                      >
                        {setEnabledMutation.isPending ? <Spinner className="size-4" /> : null}
                        Disable
                      </Button>
                    ) : (
                      <Button
                        disabled={setEnabledMutation.isPending || uninstallMutation.isPending}
                        onClick={() => void handleToggleSelectedSkill(true)}
                      >
                        {setEnabledMutation.isPending ? <Spinner className="size-4" /> : null}
                        Enable
                      </Button>
                    )
                  ) : (
                    <div className="mr-auto text-xs text-muted-foreground">
                      Initialize shared sync to enable or disable this skill in Codex.
                    </div>
                  )}
                  <Button
                    disabled={setEnabledMutation.isPending || uninstallMutation.isPending}
                    variant="destructive-outline"
                    onClick={() => void handleUninstallSelectedSkill()}
                  >
                    {uninstallMutation.isPending ? <Spinner className="size-4" /> : null}
                    Uninstall
                  </Button>
                </div>

                <div className="min-h-0 flex-1 rounded-xl border border-border bg-background p-3">
                  <div className="chat-markdown h-full text-sm">
                    <ChatMarkdown
                      cwd={selectedSkillDetail.skill.sharedPath}
                      text={selectedSkillDetail.markdown}
                    />
                  </div>
                </div>
              </>
            ) : null}
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </>
  );
}
