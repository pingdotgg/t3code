import type {
  EnvironmentId,
  MentionIndexFigmaProjectRef,
  MentionIndexFigmaSettings,
  MentionIndexFigmaTeam,
  MentionIndexJiraSettings,
  MentionIndexSettings as MentionIndexSettingsValue,
  ProjectId,
} from "@t3tools/contracts";
import { parseFigmaDesignUrl } from "@t3tools/shared/composerContextExternalLinks";
import { useEffect, useState } from "react";

import { mentionIndexEnvironment } from "../../state/pullRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function parseList(value: string, maxItems: number, maxLength: number): ReadonlyArray<string> {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const part of value.split(/[,\s]+/)) {
    const item = part.trim();
    if (item.length === 0 || item.length > maxLength || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
    if (items.length >= maxItems) break;
  }
  return items;
}

/** Accept Figma design/file URLs or bare keys; humans paste links, not opaque keys. */
function parseFigmaFileKeys(value: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const items: string[] = [];
  const add = (key: string) => {
    if (key.length === 0 || key.length > 128 || seen.has(key) || items.length >= 50) return;
    seen.add(key);
    items.push(key);
  };

  let remainder = value;
  const urlMatches = value.matchAll(
    /https?:\/\/(?:www\.)?figma\.com\/(?:file|design)\/[A-Za-z0-9]+[^\s,]*/giu,
  );
  for (const match of urlMatches) {
    const parsed = parseFigmaDesignUrl(match[0]!);
    if (parsed) add(parsed.fileKey);
    remainder = remainder.replace(match[0]!, " ");
  }
  for (const part of remainder.split(/[,\s]+/)) {
    const item = part.trim();
    if (/^[A-Za-z0-9]+$/u.test(item)) add(item);
  }
  return items;
}

function formatList(items: ReadonlyArray<string> | undefined): string {
  return items?.join(", ") ?? "";
}

function compactJira(input: {
  readonly serverName: string;
  readonly spaces: ReadonlyArray<string>;
  readonly jqlExtra: string;
}): MentionIndexJiraSettings | undefined {
  const serverName = input.serverName.trim();
  const jqlExtra = input.jqlExtra.trim();
  const jira: MentionIndexJiraSettings = {
    ...(serverName.length > 0 ? { serverName } : {}),
    ...(input.spaces.length > 0 ? { spaces: [...input.spaces] } : {}),
    ...(jqlExtra.length > 0 ? { jqlExtra } : {}),
  };
  return Object.keys(jira).length > 0 ? jira : undefined;
}

function compactFigma(input: {
  readonly serverName: string;
  readonly projects: ReadonlyArray<MentionIndexFigmaProjectRef>;
  readonly fileKeys: ReadonlyArray<string>;
}): MentionIndexFigmaSettings | undefined {
  const serverName = input.serverName.trim();
  const figma: MentionIndexFigmaSettings = {
    ...(serverName.length > 0 ? { serverName } : {}),
    ...(input.projects.length > 0 ? { projects: [...input.projects] } : {}),
    ...(input.fileKeys.length > 0 ? { fileKeys: [...input.fileKeys] } : {}),
  };
  return Object.keys(figma).length > 0 ? figma : undefined;
}

function withMentionIndex(
  current: MentionIndexSettingsValue,
  patch: {
    readonly jira?: MentionIndexJiraSettings | undefined;
    readonly figma?: MentionIndexFigmaSettings | undefined;
  },
): MentionIndexSettingsValue {
  const jira = Object.hasOwn(patch, "jira") ? patch.jira : current.jira;
  const figma = Object.hasOwn(patch, "figma") ? patch.figma : current.figma;
  return {
    ...(jira !== undefined ? { jira } : {}),
    ...(figma !== undefined ? { figma } : {}),
  };
}

export function MentionIndexSettings() {
  const enabled = useScopedSettings((settings) => settings.mentionIndexEnabled);
  if (!enabled) return null;
  return (
    <SettingsSection id="mentions" title="Mentions">
      <p className="text-secondary-label px-4 pt-3 text-xs sm:px-5">
        Jira and Figma indexes are per project. Environment defaults apply until a project overrides
        them. Pull requests and GitHub issues always follow the open project&apos;s repo. Turn the
        mention index off in Settings → Labs to restore classic @ and # menus.
      </p>
      <JiraMentionSettings />
      <FigmaMentionSettings />
    </SettingsSection>
  );
}

function JiraMentionSettings() {
  const mentionIndex = useScopedSettings((settings) => settings.mentionIndex);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mentionIndex"]);
  const jira = mentionIndex.jira;
  const serverName = jira?.serverName ?? "";
  const spaces = formatList(jira?.spaces);
  const jqlExtra = jira?.jqlExtra ?? "";
  const configured = jira !== undefined;

  const commit = (next: {
    readonly serverName: string;
    readonly spaces: ReadonlyArray<string>;
    readonly jqlExtra: string;
  }) => {
    if (mixed) return;
    updateSettings({
      mentionIndex: withMentionIndex(mentionIndex, { jira: compactJira(next) }),
    });
  };

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["mentionIndex"]}
        mixed={mixed}
        {...searchableSetting("mention-jira-spaces")}
        description="Jira project keys to index for @jira: mentions. Requires a Jira MCP server."
        resetAction={
          !mixed && configured ? (
            <SettingResetButton
              label="Jira mention spaces"
              onClick={() =>
                updateSettings({
                  mentionIndex: withMentionIndex(mentionIndex, { jira: undefined }),
                })
              }
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={mixed ? "" : spaces}
            disabled={mixed}
            onCommit={(next) =>
              commit({
                serverName,
                spaces: parseList(next, 50, 64),
                jqlExtra,
              })
            }
            placeholder={mixed ? "Mixed" : "ENG, DESIGN"}
            spellCheck={false}
            aria-label="Jira spaces"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["mentionIndex"]}
        mixed={mixed}
        {...searchableSetting("mention-jira-server")}
        description="Optional MCP server name when more than one Jira server is configured."
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={mixed ? "" : serverName}
            disabled={mixed}
            onCommit={(next) =>
              commit({
                serverName: next,
                spaces: jira?.spaces ?? [],
                jqlExtra,
              })
            }
            placeholder={mixed ? "Mixed" : "Auto-detect"}
            spellCheck={false}
            aria-label="Jira MCP server name"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["mentionIndex"]}
        mixed={mixed}
        {...searchableSetting("mention-jira-jql")}
        description="Extra JQL ANDed with the project filter when syncing issues."
        resetAction={
          !mixed && jqlExtra !== "" ? (
            <SettingResetButton
              label="Jira JQL filter"
              onClick={() =>
                commit({
                  serverName,
                  spaces: jira?.spaces ?? [],
                  jqlExtra: "",
                })
              }
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={`${mixed}:${jqlExtra}`}
            rows={2}
            defaultValue={mixed ? "" : jqlExtra}
            disabled={mixed}
            placeholder={mixed ? "Mixed" : 'status != "Done"'}
            spellCheck={false}
            aria-label="Jira JQL filter"
            onBlur={(event) => {
              if (mixed) return;
              const next = event.target.value;
              if (next.trim() !== jqlExtra.trim()) {
                commit({
                  serverName,
                  spaces: jira?.spaces ?? [],
                  jqlExtra: next,
                });
              }
            }}
          />
        </div>
      </SettingsRow>
    </>
  );
}

function FigmaMentionSettings() {
  const mentionIndex = useScopedSettings((settings) => settings.mentionIndex);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mentionIndex"]);
  const { target } = useSettingsScope();
  const figma = mentionIndex.figma;
  const serverName = figma?.serverName ?? "";
  const projects = figma?.projects ?? [];
  const fileKeys = formatList(figma?.fileKeys);
  const configured = figma !== undefined;
  const [pickerOpen, setPickerOpen] = useState(false);

  const commit = (next: {
    readonly serverName: string;
    readonly projects: ReadonlyArray<MentionIndexFigmaProjectRef>;
    readonly fileKeys: ReadonlyArray<string>;
  }) => {
    if (mixed) return;
    updateSettings({
      mentionIndex: withMentionIndex(mentionIndex, { figma: compactFigma(next) }),
    });
  };

  const projectSummary =
    projects.length === 0
      ? "None"
      : projects.length <= 2
        ? projects.map((project) => project.name).join(", ")
        : `${projects.length} projects`;

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["mentionIndex"]}
        mixed={mixed}
        {...searchableSetting("mention-figma-projects")}
        description="Browse Figma teams and pick projects to index for @figma:. Requires a REST-based Figma MCP with list_teams / list_projects / list_files."
        resetAction={
          !mixed && projects.length > 0 ? (
            <SettingResetButton
              label="Figma projects"
              onClick={() =>
                commit({
                  serverName,
                  projects: [],
                  fileKeys: figma?.fileKeys ?? [],
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            <span className="text-secondary-label max-w-40 truncate text-sm sm:max-w-56">
              {mixed ? "Mixed" : projectSummary}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={mixed}
              onClick={() => setPickerOpen(true)}
            >
              Browse
            </Button>
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["mentionIndex"]}
        mixed={mixed}
        {...searchableSetting("mention-figma-files")}
        description="Optional extra design links merged with project files. You can still paste a link in chat to attach a design directly."
        resetAction={
          !mixed && configured ? (
            <SettingResetButton
              label="Figma mention settings"
              onClick={() =>
                updateSettings({
                  mentionIndex: withMentionIndex(mentionIndex, { figma: undefined }),
                })
              }
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={mixed ? "" : fileKeys}
            disabled={mixed}
            onCommit={(next) =>
              commit({
                serverName,
                projects,
                fileKeys: parseFigmaFileKeys(next),
              })
            }
            placeholder={mixed ? "Mixed" : "https://figma.com/design/…"}
            spellCheck={false}
            aria-label="Figma file keys"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["mentionIndex"]}
        mixed={mixed}
        {...searchableSetting("mention-figma-server")}
        description="Optional MCP server name when more than one Figma server is configured."
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={mixed ? "" : serverName}
            disabled={mixed}
            onCommit={(next) =>
              commit({
                serverName: next,
                projects,
                fileKeys: figma?.fileKeys ?? [],
              })
            }
            placeholder={mixed ? "Mixed" : "Auto-detect"}
            spellCheck={false}
            aria-label="Figma MCP server name"
          />
        }
      />
      {!mixed && target !== null && pickerOpen ? (
        <FigmaProjectPickerDialog
          open
          onOpenChange={setPickerOpen}
          environmentId={target.environmentId}
          projectId={target.projectId}
          serverName={serverName}
          selected={projects}
          onSave={(nextProjects) => {
            commit({
              serverName,
              projects: nextProjects,
              fileKeys: figma?.fileKeys ?? [],
            });
            setPickerOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function FigmaProjectPickerDialog({
  open,
  onOpenChange,
  environmentId,
  projectId,
  serverName,
  selected,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly serverName: string;
  readonly selected: ReadonlyArray<MentionIndexFigmaProjectRef>;
  readonly onSave: (projects: ReadonlyArray<MentionIndexFigmaProjectRef>) => void;
}) {
  const listTeams = useAtomCommand(mentionIndexEnvironment.figmaListTeams, {
    reportFailure: false,
  });
  const listProjects = useAtomCommand(mentionIndexEnvironment.figmaListProjects, {
    reportFailure: false,
  });
  const [teams, setTeams] = useState<ReadonlyArray<MentionIndexFigmaTeam>>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ReadonlyArray<MentionIndexFigmaProjectRef>>([]);
  const [picked, setPicked] = useState<Map<string, MentionIndexFigmaProjectRef>>(
    () => new Map(selected.map((project) => [project.id, project])),
  );
  const [detail, setDetail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const browseInput = {
    ...(projectId !== null ? { projectId } : {}),
    ...(serverName.trim().length > 0 ? { serverName: serverName.trim() } : {}),
  };

  const loadTeams = async () => {
    setLoading(true);
    setDetail(null);
    const result = await listTeams({ environmentId, input: browseInput });
    setLoading(false);
    if (result._tag !== "Success") {
      setDetail("Could not list Figma teams.");
      setTeams([]);
      return;
    }
    setTeams(result.value.teams);
    setDetail(result.value.detail ?? null);
    const first = result.value.teams[0];
    if (first) {
      setTeamId(first.id);
      await loadProjects(first.id);
    } else {
      setTeamId(null);
      setProjects([]);
    }
  };

  const loadProjects = async (nextTeamId: string) => {
    setLoading(true);
    setDetail(null);
    const result = await listProjects({
      environmentId,
      input: { ...browseInput, teamId: nextTeamId },
    });
    setLoading(false);
    if (result._tag !== "Success") {
      setDetail("Could not list Figma projects.");
      setProjects([]);
      return;
    }
    setProjects(result.value.projects);
    setDetail(result.value.detail ?? null);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetch Figma teams when this dialog mounts (parent remounts on each Browse)
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- loadTeams kicks off an async RPC; state updates land after the response
    void loadTeams();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- parent remounts this dialog on each Browse open
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Figma projects</DialogTitle>
          <DialogDescription>
            Files in the selected projects are indexed for @figma: on sync.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {teams.length > 0 ? (
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-secondary-label text-xs">Team</span>
                <select
                  className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                  value={teamId ?? ""}
                  aria-label="Figma team"
                  onChange={(event) => {
                    const next = event.target.value;
                    setTeamId(next);
                    void loadProjects(next);
                  }}
                >
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="border-border max-h-64 overflow-y-auto rounded-md border">
              {loading ? (
                <p className="text-secondary-label px-3 py-4 text-sm">Loading…</p>
              ) : projects.length === 0 ? (
                <p className="text-secondary-label px-3 py-4 text-sm">
                  {detail ?? "No projects in this team."}
                </p>
              ) : (
                <ul className="divide-border divide-y">
                  {projects.map((project) => {
                    const checked = picked.has(project.id);
                    return (
                      <li key={project.id}>
                        <label className="hover:bg-muted/40 flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(next) => {
                              setPicked((current) => {
                                const copy = new Map(current);
                                if (next === true) copy.set(project.id, project);
                                else copy.delete(project.id);
                                return copy;
                              });
                            }}
                            aria-label={project.name}
                          />
                          <span className="min-w-0 truncate">{project.name}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {detail && projects.length > 0 ? (
              <p className="text-secondary-label text-xs">{detail}</p>
            ) : null}
            {picked.size > 0 ? (
              <p className="text-secondary-label text-xs">{picked.size} selected</p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => onSave([...picked.values()].slice(0, 50))}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
