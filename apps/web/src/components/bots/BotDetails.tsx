import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  BOT_NAME_MAX_LENGTH,
  type BotAvatarColor,
  type BotAvatarShape,
  type ProjectBot,
  type ProjectEntry,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { DownloadIcon, FolderIcon, FolderOpenIcon, ImageIcon, Trash2Icon } from "lucide-react";
import { msg, T, useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { saveUrlAsFile, useAssetUrlRefresh } from "~/assets/assetUrls";
import { useTheme } from "~/hooks/useTheme";
import { m } from "~/i18n/messages";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentProviders } from "../../state/environments";
import { useQuietThreadShell, useThreadShell } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { getDisplayModelName } from "../chat/providerIconUtils";
import { ThreadAutomationsPanel } from "../chat/ThreadAutomationsPanel";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { Button, ContentButton } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { BotAvatar } from "./BotAvatar";
import { BotAvatarPicker } from "./BotAvatarPicker";
import { DeleteBotDialog } from "./DeleteBotDialog";

type BotTab = "details" | "artifacts" | "computer";

function reportFailure(title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : m(msg("An error occurred.")),
  });
}

function knownShape(value: string): BotAvatarShape {
  return BOT_AVATAR_SHAPES.find((shape) => shape === value) ?? "circle";
}

function knownColor(value: string): BotAvatarColor {
  return BOT_AVATAR_COLORS.find((color) => color === value) ?? "gray";
}

type AvatarChange = { shape: BotAvatarShape; color: BotAvatarColor; imagePath?: null };

function sameAvatar(left: ProjectBot["avatar"], right: ProjectBot["avatar"]) {
  return (
    left.shape === right.shape &&
    left.color === right.color &&
    (left.imagePath ?? null) === (right.imagePath ?? null)
  );
}

function AvatarEditor({
  project,
  bot,
  threadRef,
}: {
  project: EnvironmentProject;
  bot: ProjectBot;
  threadRef: ScopedThreadRef;
}) {
  const gt = useGT();
  const updateBot = useOrchestrationCommand(serverEnvironment.updateBot, { reportFailure: false });
  const generateAvatar = useOrchestrationCommand(serverEnvironment.generateBotAvatar, {
    reportFailure: false,
  });
  const providers = useEnvironmentProviders().get(project.environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const canGenerate = providers.some(
    (provider) => provider.driver === "codex" && provider.enabled && provider.status === "ready",
  );
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  // The newest pick, shown until the bot's avatar changes from the one it was picked over, so quick
  // picks build on each other even when a save returns before the project update arrives.
  const [pending, setPending] = useState<{
    change: AvatarChange;
    base: ProjectBot["avatar"];
  } | null>(null);
  const latestSave = useRef(0);
  const live = pending !== null && sameAvatar(pending.base, bot.avatar) ? pending : null;
  const avatar = live === null ? bot.avatar : { ...bot.avatar, ...live.change };
  const shape = knownShape(avatar.shape);
  const color = knownColor(avatar.color);
  const imagePath = avatar.imagePath ?? null;

  const saveAvatar = async (next: AvatarChange) => {
    const save = ++latestSave.current;
    setPending({ change: next, base: live?.base ?? bot.avatar });
    const result = await updateBot({
      environmentId: project.environmentId,
      input: { projectId: project.id, avatar: next },
    });
    if (result._tag !== "Failure") return;
    if (save === latestSave.current) setPending(null);
    reportFailure(gt("Could not update avatar"), result);
  };

  const generate = async () => {
    setGenerating(true);
    const trimmed = prompt.trim();
    const result = await generateAvatar({
      environmentId: project.environmentId,
      input: { projectId: project.id, ...(trimmed ? { prompt: trimmed } : {}) },
    });
    setGenerating(false);
    if (result._tag === "Failure") reportFailure(gt("Could not generate avatar"), result);
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={gt("Change avatar")}
            // oxlint-disable-next-line t3code/no-styled-raw-controls -- The avatar is the control; no Button variant frames a round image.
            className="cursor-pointer rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        <BotAvatar avatar={avatar} threadRef={threadRef} animateChanges className="size-14" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" className="w-72">
        <div className="flex flex-col gap-3">
          <BotAvatarPicker
            shape={shape}
            color={color}
            disabled={generating}
            onChange={(next) => void saveAvatar(next)}
          />
          {canGenerate ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void generate();
              }}
            >
              <Input
                size="sm"
                aria-label={gt("Avatar idea")}
                placeholder={gt("Avatar for {name}", { name: project.title })}
                value={prompt}
                maxLength={500}
                disabled={generating}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <Button type="submit" size="sm" variant="secondary" disabled={generating}>
                <ImageIcon />
                {generating ? gt("Generating") : gt("Generate")}
              </Button>
            </form>
          ) : null}
          {imagePath !== null ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={generating}
              onClick={() => void saveAvatar({ shape, color, imagePath: null })}
            >
              <T>Use shape instead</T>
            </Button>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function BotName({ project }: { project: EnvironmentProject }) {
  const gt = useGT();
  const updateBot = useOrchestrationCommand(serverEnvironment.updateBot, { reportFailure: false });
  const [draft, setDraft] = useState<string | null>(null);
  const commit = async () => {
    const name = draft?.trim() ?? "";
    setDraft(null);
    if (name.length === 0 || name === project.title) return;
    const result = await updateBot({
      environmentId: project.environmentId,
      input: { projectId: project.id, name },
    });
    if (result._tag === "Failure") reportFailure(gt("Could not rename bot"), result);
  };
  if (draft === null) {
    return (
      <button
        type="button"
        onClick={() => setDraft(project.title)}
        // oxlint-disable-next-line t3code/no-styled-raw-controls -- Click-to-rename text that becomes an input; it must read as the title.
        className="min-w-0 cursor-text truncate rounded-md text-left text-label outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {project.title}
      </button>
    );
  }
  return (
    <Input
      size="sm"
      autoFocus
      aria-label={gt("Bot name")}
      maxLength={BOT_NAME_MAX_LENGTH}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(null);
      }}
    />
  );
}

function BotModel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const shell = useThreadShell(threadRef);
  const providers =
    useEnvironmentProviders().get(threadRef.environmentId) ?? EMPTY_SERVER_PROVIDERS;
  if (shell === null) return null;
  const { instanceId, model } = shell.modelSelection;
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  const known = provider?.models.find((entry) => entry.slug === model);
  return (
    <p className="truncate px-2.5 text-body text-foreground">
      {known ? getDisplayModelName(known) : formatModelSlugName(model)}
      {provider?.displayName ? (
        <span className="text-muted-foreground"> on {provider.displayName}</span>
      ) : null}
    </p>
  );
}

type ArtifactFolderProps = {
  project: EnvironmentProject;
  threadRef: ScopedThreadRef;
  directoryPath: string;
  depth: number;
  runCompletedAt: string | null;
};

function artifactRowIndent(depth: number) {
  return { paddingLeft: `${0.5 + depth}rem` };
}

function useArtifactEntries({
  project,
  directoryPath,
  runCompletedAt,
}: Pick<ArtifactFolderProps, "project" | "directoryPath" | "runCompletedAt">) {
  const query = useEnvironmentQuery(
    projectEnvironment.listEntries({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot, directoryPath },
    }),
  );
  // A listing fetched before the latest run finished may miss files the agent wrote, including a
  // cached one shown when a folder reopens. Once per run, so a skewed server clock can't loop it.
  const refreshedFor = useRef<string | null>(null);
  const { refresh, dataUpdatedAt, isPending } = query;
  const loaded = query.data !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads the folder from disk after a run, since the agent may have written files
  useEffect(() => {
    if (runCompletedAt === null || !loaded || isPending) return;
    if (refreshedFor.current === runCompletedAt) return;
    refreshedFor.current = runCompletedAt;
    if (dataUpdatedAt < Date.parse(runCompletedAt)) refresh();
  }, [runCompletedAt, loaded, isPending, dataUpdatedAt, refresh]);
  const entries = (query.data?.entries ?? []).toSorted(
    (left, right) =>
      (left.kind === "directory" ? 0 : 1) - (right.kind === "directory" ? 0 : 1) ||
      left.path.localeCompare(right.path),
  );
  return { entries, loading: query.isPending && query.data === null };
}

function ArtifactEntries({
  entries,
  ...props
}: ArtifactFolderProps & { entries: ReadonlyArray<ProjectEntry> }) {
  return (
    <ul className="flex flex-col">
      {entries.map((entry) => {
        const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        return entry.kind === "directory" ? (
          <ArtifactDirectory key={entry.path} {...props} directoryPath={entry.path} name={name} />
        ) : (
          <ArtifactFile key={entry.path} {...props} path={entry.path} name={name} />
        );
      })}
    </ul>
  );
}

function ArtifactFile({
  path,
  name,
  ...props
}: ArtifactFolderProps & { path: string; name: string }) {
  const gt = useGT();
  const { resolvedTheme } = useTheme();
  const [saving, setSaving] = useState(false);
  const prepareDownload = useAssetUrlRefresh(props.project.environmentId, {
    _tag: "media-file",
    threadId: props.threadRef.threadId,
    path: resolvePathLinkTarget(path, props.project.workspaceRoot),
    disposition: "attachment",
  });
  const download = async () => {
    setSaving(true);
    let failure: string | null = null;
    try {
      const url = await prepareDownload();
      if (url) await saveUrlAsFile(url, name);
      else failure = gt("Reconnect to the computer and try again.");
    } catch (cause) {
      failure = (cause instanceof Error && cause.message) || gt("Try again.");
    }
    setSaving(false);
    if (failure) {
      toastManager.add({
        type: "error",
        title: gt("Could not download file"),
        description: failure,
      });
    }
  };
  return (
    <li className="group relative">
      <ContentButton
        variant="inset-row"
        onClick={() => useRightPanelStore.getState().openFile(props.threadRef, path)}
        // Leaves room for the download button that appears over the row's end.
        style={{ ...artifactRowIndent(props.depth), paddingRight: "2.25rem" }}
      >
        <PierreEntryIcon pathValue={name} kind="file" theme={resolvedTheme} className="shrink-0" />
        <span className="truncate">{name}</span>
      </ContentButton>
      <span className="absolute inset-y-0 right-1 flex items-center opacity-0 pointer-coarse:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={gt("Download {name}", { name })}
          disabled={saving}
          onClick={() => void download()}
        >
          <DownloadIcon aria-hidden />
        </Button>
      </span>
    </li>
  );
}

function ArtifactFolder(props: ArtifactFolderProps) {
  const { entries } = useArtifactEntries(props);
  return <ArtifactEntries {...props} entries={entries} />;
}

function ArtifactDirectory({ name, ...props }: ArtifactFolderProps & { name: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li>
      <ContentButton
        variant="inset-row"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        style={artifactRowIndent(props.depth)}
      >
        {expanded ? (
          <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{name}</span>
      </ContentButton>
      {expanded ? <ArtifactFolder {...props} depth={props.depth + 1} /> : null}
    </li>
  );
}

function BotArtifacts({
  project,
  threadRef,
}: {
  project: EnvironmentProject;
  threadRef: ScopedThreadRef;
}) {
  const gt = useGT();
  const runCompletedAt = useQuietThreadShell(threadRef)?.latestRun?.completedAt ?? null;
  const props = { project, threadRef, directoryPath: "artifacts", depth: 0, runCompletedAt };
  const { entries, loading } = useArtifactEntries(props);
  if (entries.length === 0) {
    return (
      <p className="px-2.5 py-2 text-body text-muted-foreground">
        {loading ? gt("Loading") : gt("No artifacts yet")}
      </p>
    );
  }
  return <ArtifactEntries {...props} entries={entries} />;
}

function BotComputer({ project }: { project: EnvironmentProject }) {
  const gt = useGT();
  const navigate = useNavigate();
  const { presentation } = useEnvironmentPresentation(project.environmentId);
  const deleteBot = useOrchestrationCommand(serverEnvironment.deleteBot, { reportFailure: false });
  const canDelete = useAtomValue(serverEnvironment.deleteBot.permissionAtom(project.environmentId));
  const [confirming, setConfirming] = useState(false);
  const remove = async () => {
    const result = await deleteBot({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    });
    if (result._tag === "Failure") {
      reportFailure(gt("Could not delete bot"), result);
      return;
    }
    setConfirming(false);
    void navigate({ to: "/bots" });
  };
  const rows: Array<[string, string]> = [
    [gt("Computer"), presentation?.entry.target.label ?? gt("Unknown")],
    [
      gt("Status"),
      presentation?.connection.phase === "connected" ? gt("Connected") : gt("Offline"),
    ],
  ];
  return (
    <div className="flex flex-col gap-4 px-2.5 py-1">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-body">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t pt-4">
        <Button
          variant="destructive-outline"
          className="w-full"
          disabled={!canDelete}
          onClick={() => setConfirming(true)}
        >
          <Trash2Icon />
          <T>Delete bot</T>
        </Button>
      </div>
      <DeleteBotDialog
        name={project.title}
        open={confirming}
        onOpenChange={setConfirming}
        onDelete={remove}
      />
    </div>
  );
}

/** The right panel for a bot's session: who it is, what it made, and where it runs. */
export function BotDetails({
  project,
  bot,
  threadRef,
}: {
  project: EnvironmentProject;
  bot: ProjectBot;
  threadRef: ScopedThreadRef;
}) {
  const gt = useGT();
  const [tab, setTab] = useState<BotTab>("details");
  return (
    <>
      <div className="flex items-center gap-3 px-4 pt-4 pb-2">
        <AvatarEditor project={project} bot={bot} threadRef={threadRef} />
        <div className="flex min-w-0 flex-1 flex-col">
          <BotName project={project} />
        </div>
      </div>
      <div className="px-4 pb-2">
        <ToggleGroup
          aria-label={gt("Bot details")}
          className="w-full *:flex-1"
          value={[tab]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "details" || value === "artifacts" || value === "computer") setTab(value);
          }}
        >
          <Toggle value="details">
            <T>Details</T>
          </Toggle>
          <Toggle value="artifacts">
            <T>Artifacts</T>
          </Toggle>
          <Toggle value="computer">
            <T>Computer</T>
          </Toggle>
        </ToggleGroup>
      </div>
      {tab === "details" ? (
        <>
          <ThreadDetailsSection title={gt("Description")}>
            <p className="px-2.5 text-body whitespace-pre-wrap text-foreground">
              {bot.description ?? (
                <span className="text-muted-foreground">
                  <T>Written after your first chat</T>
                </span>
              )}
            </p>
          </ThreadDetailsSection>
          <ThreadDetailsSection title={gt("Model")}>
            <BotModel threadRef={threadRef} />
          </ThreadDetailsSection>
          <ThreadAutomationsPanel
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            title={gt("Routines")}
            emptyText={gt("No routines yet")}
          />
        </>
      ) : tab === "artifacts" ? (
        <ThreadDetailsSection title={gt("Artifacts")} variant="workspace">
          <BotArtifacts project={project} threadRef={threadRef} />
        </ThreadDetailsSection>
      ) : (
        <ThreadDetailsSection title={gt("Computer")} variant="workspace">
          <BotComputer project={project} />
        </ThreadDetailsSection>
      )}
    </>
  );
}
