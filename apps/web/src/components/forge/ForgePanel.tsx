import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  GameAsset,
  GameAssetToolStatus,
  GameCheckpointDiff,
  GameDevWorkspace,
  GameEngineStatus,
  GameInstallTarget,
  GameProject,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { GAME_RECIPES, recipePrompt } from "@t3tools/shared/gameDevRecipes";
import {
  BoxIcon,
  CameraIcon,
  CheckIcon,
  DownloadIcon,
  FolderSearchIcon,
  GamepadIcon,
  HistoryIcon,
  KeyRoundIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SquareIcon,
  WandIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { cn } from "../../lib/utils";
import { gameDevEnvironment } from "../../state/gameDev";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureText } from "../continuum/commandFailure";
import { useLoadedImage } from "../continuum/useLoadedImage";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import {
  type ForgeTab,
  formatBytes,
  installProgressLabel,
  sortEngines,
  timelineTone,
  visibleTimeline,
} from "./ForgePanel.logic";

const TABS: ReadonlyArray<{ id: ForgeTab; label: string }> = [
  { id: "project", label: "Project" },
  { id: "engines", label: "Engines" },
  { id: "assets", label: "Assets" },
  { id: "settings", label: "Settings" },
];

/**
 * Continuum Forge: game engines, Blender, and asset work for the thread's project. Everything
 * here goes through the same Game Development service the agent's tools use, so what the user
 * sees is what the agent can do.
 */
export function ForgePanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly visible: boolean;
}) {
  const [tab, setTab] = useState<ForgeTab>("project");
  const environmentId = props.threadRef.environmentId;
  const askAgent = (text: string) => {
    useComposerDraftStore.getState().setPrompt(props.composerDraftTarget, text);
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b px-3 py-2">
        <GamepadIcon className="size-4 text-primary" />
        <span className="font-semibold text-sm">Forge</span>
        <ToggleGroup
          aria-label="Forge section"
          variant="segmented"
          className="ms-auto"
          value={[tab]}
          onValueChange={(next) => {
            const value = TABS.find((entry) => entry.id === next[0]);
            if (value) setTab(value.id);
          }}
        >
          {TABS.map((entry) => (
            <ToggleGroupItem key={entry.id} value={entry.id} size="xs">
              {entry.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!props.visible ? null : tab === "engines" ? (
          <EnginesTab environmentId={environmentId} />
        ) : tab === "settings" ? (
          <SettingsTab environmentId={environmentId} />
        ) : props.workspaceRoot === undefined ? (
          <p className="p-4 text-muted-foreground text-sm">
            Forge works on a project folder. Open this thread in a project to use it.
          </p>
        ) : tab === "project" ? (
          <ProjectTab
            environmentId={environmentId}
            projectRoot={props.workspaceRoot}
            onAskAgent={askAgent}
          />
        ) : (
          <AssetsTab
            environmentId={environmentId}
            projectRoot={props.workspaceRoot}
            onAskAgent={askAgent}
          />
        )}
      </div>
    </div>
  );
}

function ForgeSection(props: {
  readonly title: string;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-border border-b px-3 py-3 last:border-b-0">
      <div className="mb-2 flex items-center gap-2">
        {props.icon}
        <h3 className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
          {props.title}
        </h3>
        {props.action ? (
          <div className="ms-auto flex items-center gap-1">{props.action}</div>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

function ForgeError({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <Alert variant="error" className="my-2">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function ProjectTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectRoot: string;
  readonly onAskAgent: (text: string) => void;
}) {
  const query = useEnvironmentQuery(
    gameDevEnvironment.workspace({
      environmentId: props.environmentId,
      input: { projectRoot: props.projectRoot },
    }),
  );
  const workspace = query.data;
  if (query.error && !workspace) {
    return (
      <div className="p-3">
        <ForgeError message={query.error} />
        <Button size="xs" variant="outline" onClick={query.refresh}>
          <RefreshCwIcon /> Try again
        </Button>
      </div>
    );
  }
  if (!workspace) return <p className="p-4 text-muted-foreground text-sm">Reading project…</p>;
  return (
    <>
      <ProjectsSection
        environmentId={props.environmentId}
        workspace={workspace}
        onChanged={query.refresh}
      />
      <SessionSection environmentId={props.environmentId} workspace={workspace} />
      <ApprovalsSection
        environmentId={props.environmentId}
        workspace={workspace}
        onChanged={query.refresh}
      />
      <CheckpointsSection
        environmentId={props.environmentId}
        workspace={workspace}
        onChanged={query.refresh}
      />
      <RecipesSection workspace={workspace} onAskAgent={props.onAskAgent} />
      <TimelineSection workspace={workspace} />
    </>
  );
}

function ProjectsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly workspace: GameDevWorkspace;
  readonly onChanged: () => void;
}) {
  const openProject = useAtomCommand(gameDevEnvironment.openProject, { reportFailure: false });
  const canOpen = useAtomValue(gameDevEnvironment.openProject.permissionAtom(props.environmentId));
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<{ project: GameProject; text: string } | null>(null);

  const open = async (project: GameProject, confirmUpgrade: boolean) => {
    setBusy(project.root);
    setError(null);
    setMessage(null);
    const result = await openProject({
      environmentId: props.environmentId,
      input: {
        engine: project.engine,
        projectRoot: project.root,
        ...(confirmUpgrade ? { confirmUpgrade: true } : {}),
      },
    });
    setBusy(null);
    if (result._tag !== "Success") {
      setError(commandFailureText(result, "The editor did not open."));
      return;
    }
    if (result.value.upgradeRequired) {
      setUpgrade({ project, text: result.value.upgradeRequired.message });
      return;
    }
    setUpgrade(null);
    setMessage(result.value.message);
    props.onChanged();
  };

  return (
    <ForgeSection title="Game projects" icon={<GamepadIcon className="size-3.5" />}>
      {props.workspace.projects.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No Godot, Roblox, Unity, or Unreal project found in this folder. Ask the agent to create
          one, or open a folder that contains a project file.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {props.workspace.projects.map((project) => (
            <li
              key={project.root}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/40 p-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-sm">{project.name}</div>
                <div className="truncate text-muted-foreground text-xs">
                  {project.engine}
                  {project.pinnedVersion ? ` · ${project.pinnedVersion}` : ""}
                  {project.bridgeInstalled ? " · bridge installed" : ""}
                </div>
              </div>
              <Button
                size="xs"
                disabled={!canOpen || busy !== null}
                onClick={() => void open(project, false)}
              >
                <PlayIcon /> {busy === project.root ? "Opening…" : "Open in editor"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {upgrade ? (
        <Alert variant="warning" className="mt-2">
          <AlertDescription>
            <p>{upgrade.text}</p>
            <div className="mt-2 flex gap-2">
              <Button size="xs" onClick={() => void open(upgrade.project, true)}>
                Upgrade and open
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setUpgrade(null)}>
                Cancel
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {message ? <p className="mt-2 text-muted-foreground text-xs">{message}</p> : null}
      <ForgeError message={error} />
    </ForgeSection>
  );
}

function SessionSection(props: {
  readonly environmentId: EnvironmentId;
  readonly workspace: GameDevWorkspace;
}) {
  const session = props.workspace.session;
  const runCommand = useAtomCommand(gameDevEnvironment.command, { reportFailure: false });
  const bindSession = useAtomCommand(gameDevEnvironment.bindSession, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const run = async (operation: string) => {
    if (!session) return;
    setPending(operation);
    setError(null);
    const result = await runCommand({
      environmentId: props.environmentId,
      input: { sessionId: session.sessionId, operation, args: {} },
    });
    setPending(null);
    if (result._tag !== "Success") {
      setError(commandFailureText(result, "The editor did not answer."));
      return;
    }
    if (!result.value.ok) setError(result.value.error ?? `${operation} failed.`);
  };

  return (
    <ForgeSection
      title="Editor"
      icon={<BoxIcon className="size-3.5" />}
      action={
        session ? (
          <Badge variant={session.state === "connected" ? "success" : "warning"} size="sm">
            {session.state}
          </Badge>
        ) : null
      }
    >
      {session ? (
        <>
          <div className="mb-2 text-sm">
            {session.projectName}{" "}
            <span className="text-muted-foreground text-xs">
              {session.engine} {session.editorVersion} · plugin {session.pluginVersion} ·{" "}
              {session.playState}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {session.operations.includes("playtest.start") ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={() =>
                  void run(session.playState === "playing" ? "playtest.stop" : "playtest.start")
                }
              >
                {session.playState === "playing" ? <SquareIcon /> : <PlayIcon />}
                {session.playState === "playing" ? "Stop playtest" : "Playtest"}
              </Button>
            ) : null}
            {session.operations.includes("viewport.capture") ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void run("viewport.capture")}
              >
                <CameraIcon /> Capture
              </Button>
            ) : null}
            {session.operations.includes("build.compile") ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void run("build.compile")}
              >
                <WandIcon /> Compile
              </Button>
            ) : null}
            {session.operations.includes("tests.run") ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void run("tests.run")}
              >
                <CheckIcon /> Run tests
              </Button>
            ) : null}
            {session.operations.includes("project.save") ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void run("project.save")}
              >
                Save
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          No editor is connected for this project. Open the project above; the Continuum bridge
          plugin connects when the editor starts.
        </p>
      )}
      {props.workspace.unboundSessions.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <div className="text-muted-foreground text-xs">
            Connected editors not tied to a project
          </div>
          {props.workspace.unboundSessions.map((unbound) => (
            <div key={unbound.sessionId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {unbound.projectName}{" "}
                <span className="text-muted-foreground text-xs">{unbound.engine}</span>
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={async () => {
                  const result = await bindSession({
                    environmentId: props.environmentId,
                    input: {
                      sessionId: unbound.sessionId,
                      projectRoot: props.workspace.projectRoot,
                    },
                  });
                  setError(commandFailureText(result, "The editor could not be linked."));
                }}
              >
                Use with this project
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {props.workspace.compileMessages.length > 0 ? (
        <ul className="mt-3 flex max-h-40 flex-col gap-1 overflow-y-auto font-mono text-xs">
          {props.workspace.compileMessages.map((message, index) => (
            <li
              // oxlint-disable-next-line react/no-array-index-key -- compile messages have no identity and are replaced wholesale
              key={index}
              className={message.severity === "error" ? "text-destructive" : "text-warning"}
            >
              {message.file ? `${message.file}${message.line ? `:${message.line}` : ""} ` : ""}
              {message.message}
            </li>
          ))}
        </ul>
      ) : null}
      <LatestCapture
        environmentId={props.environmentId}
        captureId={props.workspace.latestCaptureId}
      />
      <ForgeError message={error} />
    </ForgeSection>
  );
}

function CaptureImage(props: {
  readonly environmentId: EnvironmentId;
  readonly captureId: string;
  readonly alt: string;
}) {
  const getCapture = useAtomCommand(gameDevEnvironment.getCapture, { reportFailure: false });
  const src = useLoadedImage(`${props.environmentId}:${props.captureId}`, async () => {
    const result = await getCapture({
      environmentId: props.environmentId,
      input: { captureId: props.captureId },
    });
    return result._tag === "Success"
      ? `data:${result.value.mimeType};base64,${result.value.dataBase64}`
      : null;
  });
  if (src === null) {
    return <div className="aspect-video w-full animate-pulse rounded-md bg-muted/50" />;
  }
  return (
    <img
      src={src}
      alt={props.alt}
      className="w-full rounded-md border border-border object-contain"
    />
  );
}

function LatestCapture(props: {
  readonly environmentId: EnvironmentId;
  readonly captureId: string | null;
}) {
  if (props.captureId === null) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-muted-foreground text-xs">Latest capture</div>
      <CaptureImage
        environmentId={props.environmentId}
        captureId={props.captureId}
        alt="Latest editor capture"
      />
    </div>
  );
}

function ApprovalsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly workspace: GameDevWorkspace;
  readonly onChanged: () => void;
}) {
  const resolve = useAtomCommand(gameDevEnvironment.resolveApproval, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  if (props.workspace.approvals.length === 0) return null;
  return (
    <ForgeSection title="Waiting for your approval">
      <ul className="flex flex-col gap-2">
        {props.workspace.approvals.map((approval) => (
          <li
            key={approval.approvalId}
            className="rounded-lg border border-warning/40 bg-warning/5 p-2 text-sm"
          >
            <div className="font-medium">{approval.operation}</div>
            <div className="text-muted-foreground text-xs">{approval.summary}</div>
            <div className="mt-2 flex gap-2">
              {[true, false].map((approve) => (
                <Button
                  key={String(approve)}
                  size="xs"
                  variant={approve ? "default" : "outline"}
                  onClick={async () => {
                    const result = await resolve({
                      environmentId: props.environmentId,
                      input: { approvalId: approval.approvalId, approve },
                    });
                    setError(commandFailureText(result, "The approval was not recorded."));
                    props.onChanged();
                  }}
                >
                  {approve ? <CheckIcon /> : <XIcon />}
                  {approve ? "Approve" : "Deny"}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <ForgeError message={error} />
    </ForgeSection>
  );
}

function CheckpointsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly workspace: GameDevWorkspace;
  readonly onChanged: () => void;
}) {
  const create = useAtomCommand(gameDevEnvironment.checkpointCreate, { reportFailure: false });
  const diff = useAtomCommand(gameDevEnvironment.checkpointDiff, { reportFailure: false });
  const restore = useAtomCommand(gameDevEnvironment.checkpointRestore, { reportFailure: false });
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GameCheckpointDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const root = props.workspace.projects[0]?.root ?? props.workspace.projectRoot;

  return (
    <ForgeSection title="Game checkpoints" icon={<HistoryIcon className="size-3.5" />}>
      <form
        className="mb-2 flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          const result = await create({
            environmentId: props.environmentId,
            input: { projectRoot: root, label: label.trim() || "Manual checkpoint" },
          });
          setBusy(false);
          setError(commandFailureText(result, "The checkpoint was not created."));
          if (result._tag === "Success") setLabel("");
          props.onChanged();
        }}
      >
        <Input
          size="sm"
          value={label}
          placeholder="Checkpoint name"
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={busy || props.workspace.projects.length === 0}>
          Save
        </Button>
      </form>
      {props.workspace.checkpoints.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No checkpoints yet. The agent saves one before scene and script changes.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {props.workspace.checkpoints.toReversed().map((checkpoint) => (
            <li key={checkpoint.checkpointId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {checkpoint.label}{" "}
                <span className="text-muted-foreground text-xs">
                  {new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.fileCount} files ·{" "}
                  {formatBytes(checkpoint.totalBytes)} · {checkpoint.createdBy}
                </span>
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  const result = await diff({
                    environmentId: props.environmentId,
                    input: {
                      projectRoot: checkpoint.projectRoot,
                      checkpointId: checkpoint.checkpointId,
                    },
                  });
                  setError(commandFailureText(result, "The checkpoint could not be compared."));
                  if (result._tag === "Success") setPreview(result.value);
                }}
              >
                Compare
              </Button>
            </li>
          ))}
        </ul>
      )}
      {preview ? (
        <div className="mt-2 rounded-lg border border-border p-2">
          <div className="mb-1 flex items-center gap-2 text-sm">
            <span className="font-medium">{preview.checkpoint.label}</span>
            <span className="text-muted-foreground text-xs">
              {preview.changes.length === 0
                ? "matches the project now"
                : `${preview.changes.length} changed since`}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="ms-auto"
              onClick={() => setPreview(null)}
            >
              <XIcon />
            </Button>
          </div>
          <ul className="max-h-60 overflow-y-auto font-mono text-xs">
            {preview.changes.map((change) => (
              <li key={change.path} className="py-0.5">
                <span
                  className={cn(
                    change.change === "added" && "text-success",
                    change.change === "deleted" && "text-destructive",
                    change.change === "modified" && "text-warning",
                  )}
                >
                  {change.change[0]?.toUpperCase()}
                </span>{" "}
                {change.path}
                {change.diff ? (
                  <pre className="mt-1 mb-2 overflow-x-auto rounded bg-muted p-1.5 text-2xs">
                    {change.diff}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
          {preview.changes.length > 0 ? (
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="xs"
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const result = await restore({
                    environmentId: props.environmentId,
                    input: {
                      projectRoot: preview.checkpoint.projectRoot,
                      checkpointId: preview.checkpoint.checkpointId,
                    },
                  });
                  setBusy(false);
                  setError(commandFailureText(result, "The checkpoint was not restored."));
                  if (result._tag === "Success") setPreview(null);
                  props.onChanged();
                }}
              >
                <RotateCcwIcon /> Restore these {preview.changes.length} files
              </Button>
              <span className="text-muted-foreground text-xs">
                Continuum saves a checkpoint of the current files first.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      <ForgeError message={error} />
    </ForgeSection>
  );
}

function RecipesSection(props: {
  readonly workspace: GameDevWorkspace;
  readonly onAskAgent: (text: string) => void;
}) {
  const engine = props.workspace.session?.engine ?? props.workspace.projects[0]?.engine ?? null;
  const [input, setInput] = useState<Record<string, string>>({});
  if (engine === null) return null;
  const recipes = GAME_RECIPES.filter((recipe) => engine in recipe.engines);
  if (recipes.length === 0) return null;
  return (
    <ForgeSection title="Recipes" icon={<WandIcon className="size-3.5" />}>
      <ul className="grid gap-2 sm:grid-cols-2">
        {recipes.map((recipe) => {
          const variant = recipe.engines[engine as keyof typeof recipe.engines];
          if (!variant) return null;
          return (
            <li
              key={recipe.id}
              className="flex flex-col gap-1.5 rounded-lg border border-border p-2"
            >
              <div className="font-medium text-sm">{recipe.title}</div>
              <div className="text-muted-foreground text-xs">{recipe.summary}</div>
              {recipe.input ? (
                <Input
                  size="sm"
                  placeholder={recipe.input.placeholder}
                  aria-label={recipe.input.label}
                  value={input[recipe.id] ?? ""}
                  onChange={(event) =>
                    setInput((current) => ({ ...current, [recipe.id]: event.target.value }))
                  }
                />
              ) : null}
              <Button
                size="xs"
                variant="outline"
                className="self-start"
                disabled={recipe.input !== null && !(input[recipe.id] ?? "").trim()}
                onClick={() =>
                  props.onAskAgent(recipePrompt(recipe, engine, input[recipe.id] ?? ""))
                }
              >
                Put in composer
              </Button>
            </li>
          );
        })}
      </ul>
    </ForgeSection>
  );
}

function TimelineSection(props: { readonly workspace: GameDevWorkspace }) {
  const [filter, setFilter] = useState<"all" | "problems" | "agent">("all");
  const entries = visibleTimeline(props.workspace, filter);
  return (
    <ForgeSection
      title="Editor timeline"
      action={
        <ToggleGroup
          aria-label="Timeline filter"
          variant="segmented"
          value={[filter]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "all" || value === "problems" || value === "agent") setFilter(value);
          }}
        >
          <ToggleGroupItem value="all" size="xs">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="problems" size="xs">
            Problems
          </ToggleGroupItem>
          <ToggleGroupItem value="agent" size="xs">
            Agent
          </ToggleGroupItem>
        </ToggleGroup>
      }
    >
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">Nothing recorded yet.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {entries.map((entry) => {
            const tone = timelineTone(entry);
            return (
              <li key={entry.id} className="flex gap-2 text-xs">
                <span className="w-16 shrink-0 text-muted-foreground tabular-nums">
                  {new Date(entry.at).toLocaleTimeString()}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words",
                    tone === "error" && "text-destructive",
                    tone === "warning" && "text-warning",
                    tone === "success" && "text-success",
                  )}
                >
                  {entry.operation ? <span className="font-mono">{entry.operation} </span> : null}
                  {entry.text}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </ForgeSection>
  );
}

function EnginesTab(props: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    gameDevEnvironment.overview({ environmentId: props.environmentId, input: {} }),
  );
  const overview = query.data;
  if (query.error && !overview) {
    return (
      <div className="p-3">
        <ForgeError message={query.error} />
      </div>
    );
  }
  if (!overview) return <p className="p-4 text-muted-foreground text-sm">Looking for editors…</p>;
  return (
    <>
      <ForgeSection
        title={`Engines on ${overview.host.label}`}
        action={
          <Badge variant={overview.bridge.listening ? "success" : "error"} size="sm">
            bridge {overview.bridge.listening ? `on :${overview.bridge.port}` : "off"}
          </Badge>
        }
      >
        {overview.bridge.error ? <ForgeError message={overview.bridge.error} /> : null}
        <ul className="flex flex-col gap-2">
          {sortEngines(overview.engines).map((engine) => (
            <EngineCard
              key={engine.engine}
              environmentId={props.environmentId}
              engine={engine}
              onChanged={query.refresh}
            />
          ))}
        </ul>
      </ForgeSection>
      <ForgeSection title="Asset tools">
        <ul className="flex flex-col gap-2">
          {overview.tools.map((tool) => (
            <ToolCard
              key={tool.tool}
              environmentId={props.environmentId}
              tool={tool}
              onChanged={query.refresh}
            />
          ))}
        </ul>
      </ForgeSection>
    </>
  );
}

function InstallButton(props: {
  readonly environmentId: EnvironmentId;
  readonly target: GameInstallTarget;
  readonly label: string;
  readonly version?: string | null;
  readonly onDone: () => void;
}) {
  const install = useAtomCommand(gameDevEnvironment.install, { reportFailure: false });
  const canInstall = useAtomValue(gameDevEnvironment.install.permissionAtom(props.environmentId));
  const [progress, setProgress] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<{ message: string; url: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="xs"
        variant="outline"
        className="self-start"
        disabled={!canInstall || progress !== null}
        onClick={async () => {
          setError(null);
          setHandoff(null);
          setProgress("Starting…");
          const result = await install({
            environmentId: props.environmentId,
            input: {
              input: {
                target: props.target,
                ...(props.version ? { version: props.version } : {}),
              },
              onEvent: (event) => {
                const label = installProgressLabel(event);
                if (event.type === "handoff")
                  setHandoff({ message: event.message, url: event.url });
                else if (label) setProgress(label);
              },
            },
          });
          setProgress(null);
          setError(commandFailureText(result, "The install did not finish."));
          props.onDone();
        }}
      >
        <DownloadIcon /> {progress ?? props.label}
      </Button>
      {handoff ? (
        <p className="text-muted-foreground text-xs">
          {handoff.message}{" "}
          {handoff.url ? (
            <a
              href={handoff.url}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              Open download page
            </a>
          ) : null}
        </p>
      ) : null}
      <ForgeError message={error} />
    </div>
  );
}

function LocateForm(props: {
  readonly environmentId: EnvironmentId;
  readonly target: GameInstallTarget;
  readonly onDone: () => void;
}) {
  const locate = useAtomCommand(gameDevEnvironment.locate, { reportFailure: false });
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex gap-1.5"
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await locate({
          environmentId: props.environmentId,
          input: { target: props.target, path: path.trim() },
        });
        setError(commandFailureText(result, "That path is not a usable editor."));
        if (result._tag === "Success") setPath("");
        props.onDone();
      }}
    >
      <Input
        size="sm"
        value={path}
        placeholder="Path to an existing install"
        onChange={(event) => setPath(event.target.value)}
      />
      <Button size="sm" variant="ghost" type="submit" disabled={!path.trim()}>
        <FolderSearchIcon />
      </Button>
      <ForgeError message={error} />
    </form>
  );
}

function EngineCard(props: {
  readonly environmentId: EnvironmentId;
  readonly engine: GameEngineStatus;
  readonly onChanged: () => void;
}) {
  const { engine } = props;
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="rounded-lg border border-border bg-card/40 p-2">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-start"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="font-medium text-sm">{engine.displayName}</span>
        {engine.sessions.length > 0 ? (
          <Badge variant="success" size="sm">
            connected
          </Badge>
        ) : engine.installs.length > 0 ? (
          <Badge variant="secondary" size="sm">
            {engine.installs[0]?.version}
          </Badge>
        ) : (
          <Badge variant={engine.availability === "local" ? "outline" : "warning"} size="sm">
            {engine.availability === "local" ? "not installed" : engine.availability}
          </Badge>
        )}
      </button>
      {expanded ? (
        <div className="mt-2 flex flex-col gap-2 text-xs">
          <p className="text-muted-foreground">{engine.availabilityReason}</p>
          {engine.installs.map((install) => (
            <div key={install.path} className="truncate font-mono text-2xs">
              {install.version} · {install.path} ({install.source})
            </div>
          ))}
          {engine.controls.length > 0 ? (
            <ul className="list-disc ps-4 text-muted-foreground">
              {engine.controls.map((control) => (
                <li key={control}>{control}</li>
              ))}
            </ul>
          ) : null}
          {engine.installer.kind !== "unavailable" ? (
            <>
              <p className="text-muted-foreground">
                {engine.installer.title} from {engine.installer.source}
                {engine.installer.requiresSignIn ? " · needs sign-in" : ""}
                {engine.installer.requiresAdmin ? " · needs administrator" : ""}
              </p>
              {engine.installer.commands.map((command) => (
                <pre key={command} className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono">
                  {command}
                </pre>
              ))}
              {engine.installer.steps.map((step) => (
                <p key={step} className="text-muted-foreground">
                  • {step}
                </p>
              ))}
              {engine.installer.kind !== "package-manager" ? (
                <InstallButton
                  environmentId={props.environmentId}
                  target={engine.installer.target}
                  label={`Install ${engine.displayName}`}
                  version={engine.recommendedVersion}
                  onDone={props.onChanged}
                />
              ) : null}
            </>
          ) : null}
          {engine.launcherInstaller && engine.launcher === null ? (
            <InstallButton
              environmentId={props.environmentId}
              target={engine.launcherInstaller.target}
              label={`Install ${engine.launcherInstaller.title}`}
              onDone={props.onChanged}
            />
          ) : null}
          <LocateForm
            environmentId={props.environmentId}
            target={engine.installer.target}
            onDone={props.onChanged}
          />
        </div>
      ) : null}
    </li>
  );
}

function ToolCard(props: {
  readonly environmentId: EnvironmentId;
  readonly tool: GameAssetToolStatus;
  readonly onChanged: () => void;
}) {
  const { tool } = props;
  return (
    <li className="rounded-lg border border-border bg-card/40 p-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm">{tool.displayName}</span>
        <Badge variant={tool.installed || tool.configured ? "success" : "outline"} size="sm">
          {tool.installed ? tool.installed.version : tool.configured ? "configured" : "not set up"}
        </Badge>
      </div>
      <p className="mt-1 text-muted-foreground text-xs">{tool.detail}</p>
      {tool.tool === "forgegui" ? (
        <ForgeGuiKeyForm
          environmentId={props.environmentId}
          configured={tool.configured}
          onDone={props.onChanged}
        />
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {tool.installer && tool.installed === null ? (
            tool.installer.kind === "package-manager" ? (
              tool.installer.commands.map((command) => (
                <pre
                  key={command}
                  className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs"
                >
                  {command}
                </pre>
              ))
            ) : (
              <InstallButton
                environmentId={props.environmentId}
                target="blender"
                label="Install Blender"
                onDone={props.onChanged}
              />
            )
          ) : null}
          {tool.installed === null ? (
            <LocateForm
              environmentId={props.environmentId}
              target="blender"
              onDone={props.onChanged}
            />
          ) : null}
        </div>
      )}
    </li>
  );
}

function ForgeGuiKeyForm(props: {
  readonly environmentId: EnvironmentId;
  readonly configured: boolean;
  readonly onDone: () => void;
}) {
  const setKey = useAtomCommand(gameDevEnvironment.setForgeGuiKey, { reportFailure: false });
  const test = useAtomCommand(gameDevEnvironment.testForgeGui, { reportFailure: false });
  const [key, setKeyValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <form
        className="flex gap-1.5"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await setKey({
            environmentId: props.environmentId,
            input: { apiKey: key.trim() },
          });
          setError(commandFailureText(result, "The key was not saved."));
          if (result._tag === "Success") setKeyValue("");
          props.onDone();
        }}
      >
        <Input
          size="sm"
          type="password"
          autoComplete="off"
          value={key}
          placeholder={props.configured ? "Replace the stored API key" : "ForgeGUI API key"}
          onChange={(event) => setKeyValue(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={!key.trim()}>
          <KeyRoundIcon /> Save
        </Button>
      </form>
      {props.configured ? (
        <div className="flex gap-1.5">
          <Button
            size="xs"
            variant="outline"
            onClick={async () => {
              const result = await test({ environmentId: props.environmentId, input: {} });
              setError(commandFailureText(result, "ForgeGUI did not answer."));
              if (result._tag === "Success") setMessage(result.value.message);
            }}
          >
            Test connection
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={async () => {
              const result = await setKey({
                environmentId: props.environmentId,
                input: { apiKey: null },
              });
              setError(commandFailureText(result, "The key was not removed."));
              props.onDone();
            }}
          >
            Remove key
          </Button>
        </div>
      ) : null}
      {message ? <p className="text-muted-foreground text-xs">{message}</p> : null}
      <ForgeError message={error} />
    </div>
  );
}

function AssetsTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectRoot: string;
  readonly onAskAgent: (text: string) => void;
}) {
  const query = useEnvironmentQuery(
    gameDevEnvironment.assets({
      environmentId: props.environmentId,
      input: { projectRoot: props.projectRoot },
    }),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const assets = query.data ?? [];
  const asset = assets.find((candidate) => candidate.assetId === selected) ?? assets[0] ?? null;
  return (
    <>
      <ForgeSection
        title="Asset library"
        action={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh assets"
            onClick={query.refresh}
          >
            <RefreshCwIcon />
          </Button>
        }
      >
        <ForgeError message={query.error} />
        {assets.length === 0 ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">
              No assets yet. Ask the agent for a model or texture: it builds it in Blender (or
              ForgeGUI), keeps the editable source file, renders a preview, and checks it before
              anything is imported.
            </p>
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              onClick={() =>
                props.onAskAgent(
                  "Create a game asset with Continuum Forge: a low-poly wooden crate, about 1 m, under 500 triangles, one 512 px texture. Keep the .blend source, render a preview, run the asset checks, and show me the preview before importing it.",
                )
              }
            >
              <WandIcon /> Example request
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {assets.map((candidate) => (
              <button
                key={candidate.assetId}
                type="button"
                onClick={() => setSelected(candidate.assetId)}
                className={cn(
                  "flex flex-col gap-1 rounded-lg border p-2 text-start transition-colors",
                  candidate.assetId === asset?.assetId
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent/40",
                )}
              >
                <span className="truncate font-medium text-sm">{candidate.name}</span>
                <span className="text-muted-foreground text-xs">
                  {candidate.kind} · r{candidate.revisions.at(-1)?.revision ?? 0}
                  {candidate.activeRevision !== null
                    ? ` · in engine r${candidate.activeRevision}`
                    : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </ForgeSection>
      {asset ? (
        <AssetDetail
          key={asset.assetId}
          environmentId={props.environmentId}
          asset={asset}
          onChanged={query.refresh}
        />
      ) : null}
    </>
  );
}

function AssetDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly asset: GameAsset;
  readonly onChanged: () => void;
}) {
  const { asset } = props;
  const latest = asset.revisions.at(-1) ?? null;
  const [revisionNumber, setRevisionNumber] = useState(latest?.revision ?? 0);
  const revision = asset.revisions.find((entry) => entry.revision === revisionNumber) ?? latest;
  const preview = useAtomCommand(gameDevEnvironment.assetPreview, { reportFailure: false });
  const importAsset = useAtomCommand(gameDevEnvironment.assetImport, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [replace, setReplace] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const image = useLoadedImage(
    revision?.previewPath
      ? `${props.environmentId}:${asset.assetId}:${revision.revision}:${revision.previewPath}`
      : null,
    async () => {
      if (!revision) return null;
      const result = await preview({
        environmentId: props.environmentId,
        input: {
          projectRoot: asset.projectRoot,
          assetId: asset.assetId,
          revision: revision.revision,
        },
      });
      return result._tag === "Success"
        ? `data:${result.value.mimeType};base64,${result.value.dataBase64}`
        : null;
    },
  );

  if (!revision) return null;
  const runImport = async (confirmReplace: boolean) => {
    setBusy(true);
    setError(null);
    const result = await importAsset({
      environmentId: props.environmentId,
      input: {
        projectRoot: asset.projectRoot,
        assetId: asset.assetId,
        revision: revision.revision,
        ...(confirmReplace ? { confirmReplace: true } : {}),
      },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      setError(commandFailureText(result, "The import did not finish."));
      return;
    }
    setReplace(result.value.replaceRequired);
    props.onChanged();
  };

  return (
    <ForgeSection title={asset.name}>
      <div className="mb-2 flex flex-wrap gap-1">
        {asset.revisions.map((entry) => (
          <Button
            key={entry.revision}
            size="xs"
            variant={entry.revision === revision.revision ? "secondary" : "ghost"}
            onClick={() => setRevisionNumber(entry.revision)}
          >
            r{entry.revision}
          </Button>
        ))}
      </div>
      {revision.previewPath ? (
        image ? (
          <img
            src={image}
            alt={`${asset.name} revision ${revision.revision}`}
            className="mb-2 w-full rounded-md border border-border bg-muted/30 object-contain"
          />
        ) : (
          <div className="mb-2 aspect-video w-full animate-pulse rounded-md bg-muted/50" />
        )
      ) : null}
      <p className="text-sm">{revision.note}</p>
      <p className="mb-2 text-muted-foreground text-xs">
        {revision.tool} · {revision.createdBy} · {new Date(revision.createdAt).toLocaleString()}
        {revision.stats.triangles !== null ? ` · ${revision.stats.triangles} tris` : ""}
        {revision.stats.materials !== null ? ` · ${revision.stats.materials} materials` : ""}
        {revision.forgeGui?.creditsCharged != null
          ? ` · ${revision.forgeGui.creditsCharged} ForgeGUI credits`
          : ""}
      </p>
      {revision.checks.length > 0 ? (
        <ul className="mb-2 flex flex-col gap-0.5 text-xs">
          {revision.checks.map((check) => (
            <li key={check.name} className="flex gap-2">
              <Badge
                size="sm"
                variant={
                  check.status === "pass"
                    ? "success"
                    : check.status === "warn"
                      ? "warning"
                      : "error"
                }
              >
                {check.status}
              </Badge>
              <span className="font-medium">{check.name}</span>
              <span className="text-muted-foreground">{check.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="mb-2 font-mono text-2xs text-muted-foreground">
        {revision.files.map((file) => (
          <li key={file.path}>
            {file.role}: {file.path} ({formatBytes(file.bytes)})
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" disabled={busy} onClick={() => void runImport(false)}>
          Import r{revision.revision} into the engine
        </Button>
        {asset.imports.at(-1) ? (
          <span className="text-muted-foreground text-xs">
            Last import: r{asset.imports.at(-1)?.revision} → {asset.imports.at(-1)?.location} (
            {asset.imports.at(-1)?.status})
          </span>
        ) : null}
      </div>
      {replace ? (
        <Alert variant="warning" className="mt-2">
          <AlertDescription>
            <p>{replace}</p>
            <Button size="xs" className="mt-2" onClick={() => void runImport(true)}>
              Replace the imported revision
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <ForgeError message={error} />
    </ForgeSection>
  );
}

function SettingsTab(props: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    gameDevEnvironment.overview({ environmentId: props.environmentId, input: {} }),
  );
  const update = useAtomCommand(gameDevEnvironment.updateSettings, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState<string | null>(null);
  const settings = query.data?.settings;
  if (!settings) return <p className="p-4 text-muted-foreground text-sm">Loading…</p>;
  const patch = async (input: Parameters<typeof update>[0]["input"]) => {
    const result = await update({ environmentId: props.environmentId, input });
    setError(commandFailureText(result, "The setting was not saved."));
    query.refresh();
  };
  return (
    <ForgeSection title="Forge settings">
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex items-center justify-between gap-3">
          <span>
            Let agents move the editor camera
            <span className="block text-muted-foreground text-xs">
              Frames what the agent changed before it captures the viewport.
            </span>
          </span>
          <Switch
            checked={settings.allowCameraControl}
            onCheckedChange={(checked) => void patch({ allowCameraControl: checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span>
            Allow ForgeGUI publishing to Roblox
            <span className="block text-muted-foreground text-xs">
              Every upload still asks for your approval first.
            </span>
          </span>
          <Switch
            checked={settings.allowForgeGuiPublishing}
            onCheckedChange={(checked) => void patch({ allowForgeGuiPublishing: checked })}
          />
        </label>
        <form
          className="flex items-center justify-between gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(port);
            if (Number.isInteger(value) && value >= 1024 && value <= 65535) {
              void patch({ bridgePort: value });
              setPort(null);
            } else setError("Choose a port from 1024 to 65535.");
          }}
        >
          <span>
            Editor bridge port
            <span className="block text-muted-foreground text-xs">
              Loopback only. Editor plugins connect here.
            </span>
          </span>
          <Input
            size="sm"
            className="w-24"
            inputMode="numeric"
            value={port ?? String(settings.bridgePort)}
            onChange={(event) => setPort(event.target.value)}
          />
        </form>
      </div>
      <ForgeError message={error} />
    </ForgeSection>
  );
}
