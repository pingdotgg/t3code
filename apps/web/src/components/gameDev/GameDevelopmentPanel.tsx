import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  GameCheckpointDiff,
  GameDevCapture,
  GameCompileMessage,
  GameDevWorkspace,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { GAME_RECIPES, recipePrompt } from "@t3tools/shared/gameDevRecipes";
import { useEffect, useEffectEvent, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { gameDevEnvironment } from "../../state/gameDev";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const compileMessageKey = (message: GameCompileMessage) => JSON.stringify(message);

const OPERATIONS = [
  ["viewport.capture", "Capture viewport"],
  ["build.compile", "Build"],
  ["build.status", "Compile status"],
  ["playtest.start", "Start playtest"],
  ["playtest.stop", "Stop playtest"],
  ["tests.run", "Run tests"],
] as const;

type ActionResult<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | {
      readonly _tag: "Failure";
      readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
    };

function resultError(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The game development request failed.";
}

export function GameCaptureImage({
  capture,
  label,
}: {
  readonly capture: GameDevCapture;
  readonly label: string;
}) {
  return (
    <img
      className="max-h-80 w-full rounded-md bg-muted object-contain"
      alt={label}
      src={`data:${capture.mimeType};base64,${capture.dataBase64}`}
    />
  );
}

export function GameDevelopmentPanel({
  threadRef,
  projectRoot,
  visible,
  onUseRecipe,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly projectRoot: string | undefined;
  readonly visible: boolean;
  readonly onUseRecipe: (prompt: string) => void;
}) {
  if (!projectRoot)
    return (
      <p className="p-4 text-sm text-muted-foreground">Choose a project to connect an editor.</p>
    );
  return (
    <GameWorkspace
      key={`${threadRef.environmentId}:${projectRoot}`}
      environmentId={threadRef.environmentId}
      projectRoot={projectRoot}
      visible={visible}
      onUseRecipe={onUseRecipe}
    />
  );
}

function GameWorkspace({
  environmentId,
  projectRoot,
  visible,
  onUseRecipe,
}: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly projectRoot: string;
  readonly visible: boolean;
  readonly onUseRecipe: (prompt: string) => void;
}) {
  const target = { environmentId, input: { projectRoot } };
  const query = useEnvironmentQuery(gameDevEnvironment.workspace(target));
  const data = query.data;
  const session = data?.session;
  const [tab, setTab] = useState<"editor" | "timeline" | "checkpoints" | "assets" | "recipes">(
    "editor",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [capture, setCapture] = useState<GameDevCapture | null>(null);
  const [selectedEngine, setSelectedEngine] = useState<
    GameDevWorkspace["projects"][number]["engine"] | null
  >(null);
  const engine = session?.engine ?? selectedEngine ?? data?.projects[0]?.engine;
  const open = useAtomCommand(gameDevEnvironment.openProject, { reportFailure: false });
  const bind = useAtomCommand(gameDevEnvironment.bindSession, { reportFailure: false });
  const command = useAtomCommand(gameDevEnvironment.command, { reportFailure: false });
  const getCapture = useAtomCommand(gameDevEnvironment.getCapture, { reportFailure: false });
  const resolve = useAtomCommand(gameDevEnvironment.resolveApproval, { reportFailure: false });
  const canOpen = useAtomValue(gameDevEnvironment.openProject.permissionAtom(environmentId));
  const canBind = useAtomValue(gameDevEnvironment.bindSession.permissionAtom(environmentId));
  const canOperate = useAtomValue(gameDevEnvironment.command.permissionAtom(environmentId));
  const canResolve = useAtomValue(gameDevEnvironment.resolveApproval.permissionAtom(environmentId));

  const refresh = useEffectEvent(() => query.refresh());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes editor events while this visible workspace tracks a session
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(refresh, tab === "timeline" ? 2500 : 6000);
    return () => window.clearInterval(timer);
  }, [tab, visible]);

  const perform = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    await (async () => {
      await run();
    })().catch((error: unknown) => {
      setError(error instanceof Error ? error.message : "The editor action failed.");
    });
    setBusy(false);
    query.refresh();
  };
  const value = <A,>(result: ActionResult<A>): A | undefined => {
    if (result._tag === "Success") return result.value;
    setError(resultError(result));
  };
  const showCapture = async (captureId: string) => {
    const received = value(await getCapture({ environmentId, input: { captureId } }));
    if (received) setCapture(received);
  };
  const openProject = () =>
    perform(async () => {
      if (!engine) return;
      const input = { projectRoot, engine };
      let received = value(await open({ environmentId, input }));
      if (received?.upgradeRequired) {
        if (!(await requestConfirmDialog(received.upgradeRequired.message))) return;
        received = value(await open({ environmentId, input: { ...input, confirmUpgrade: true } }));
      }
      if (received) setStatus(received.message);
    });
  const runOperation = (operation: string, label: string) =>
    perform(async () => {
      if (!session) return;
      const outcome = value(
        await command({
          environmentId,
          input: { sessionId: session.sessionId, operation, args: {} },
        }),
      );
      if (!outcome) return;
      if (!outcome.ok) return setError(outcome.error ?? `${label} failed.`);
      if (outcome.captureId) await showCapture(outcome.captureId);
      setStatus(`${label} complete.`);
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <header className="space-y-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <strong className="min-w-0 flex-1 truncate">
            {session?.projectName ?? data?.projects[0]?.name ?? "Game Development"}
          </strong>
          <Badge variant={session?.state === "connected" ? "success" : "secondary"}>
            {session?.state ?? "No editor"}
          </Badge>
          <Button size="xs" variant="ghost" onClick={query.refresh}>
            Refresh
          </Button>
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">{projectRoot}</p>
        <nav aria-label="Game development views" className="flex flex-wrap gap-1">
          {(
            [
              ["editor", "Editor"],
              ["timeline", "Playtest Timeline"],
              ["checkpoints", "Checkpoints"],
              ["assets", "Assets"],
              ["recipes", "Recipes"],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              size="xs"
              variant={id === tab ? "secondary" : "ghost"}
              aria-pressed={id === tab}
              onClick={() => setTab(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {error || query.error ? (
          <Alert variant="error">
            <AlertDescription>{error ?? query.error}</AlertDescription>
          </Alert>
        ) : null}
        {status ? <p role="status">{status}</p> : null}
        {data?.approvals.map((approval) => (
          <Alert key={approval.approvalId}>
            <AlertDescription>
              <p>{approval.summary}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="xs"
                  disabled={!canResolve || busy}
                  onClick={() =>
                    void perform(async () => {
                      value(
                        await resolve({
                          environmentId,
                          input: { approvalId: approval.approvalId, approve: true },
                        }),
                      );
                    })
                  }
                >
                  Approve
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canResolve || busy}
                  onClick={() =>
                    void perform(async () => {
                      value(
                        await resolve({
                          environmentId,
                          input: { approvalId: approval.approvalId, approve: false },
                        }),
                      );
                    })
                  }
                >
                  Deny
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ))}
        {tab === "editor" ? (
          <>
            {data && !session ? (
              <div className="space-y-2">
                {data.projects.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Game engine"
                      value={engine ?? ""}
                      onChange={(event) => {
                        const next = data.projects.find(
                          (project) => project.engine === event.currentTarget.value,
                        );
                        if (next) setSelectedEngine(next.engine);
                      }}
                    >
                      {data.projects.map((project) => (
                        <option key={project.engine} value={project.engine}>
                          {project.name} · {project.engine}
                          {project.pinnedVersion ? ` · ${project.pinnedVersion}` : ""}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      disabled={busy || !canOpen}
                      onClick={() => void openProject()}
                    >
                      Launch editor and connect
                    </Button>
                  </div>
                ) : (
                  <p>No game project detected in this folder.</p>
                )}
                {data.unboundSessions.map((entry) => (
                  <Button
                    key={entry.sessionId}
                    size="sm"
                    variant="outline"
                    disabled={busy || !canBind || entry.state !== "connected"}
                    onClick={() =>
                      void perform(async () => {
                        value(
                          await bind({
                            environmentId,
                            input: { projectRoot, sessionId: entry.sessionId },
                          }),
                        );
                      })
                    }
                  >
                    Connect {entry.projectName}
                  </Button>
                ))}
              </div>
            ) : null}
            {session ? (
              <section aria-label="Editor controls" className="space-y-2">
                <p>
                  {session.editorVersion} · {session.playState}
                </p>
                <div className="flex flex-wrap gap-2">
                  {OPERATIONS.filter(([operation]) => session.operations.includes(operation)).map(
                    ([operation, label]) => (
                      <Button
                        variant="outline"
                        key={operation}
                        size="xs"
                        disabled={busy || !canOperate || session.state !== "connected"}
                        onClick={() => void runOperation(operation, label)}
                      >
                        {label}
                      </Button>
                    ),
                  )}
                  {data?.latestCaptureId ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void showCapture(data.latestCaptureId!)}
                    >
                      Show latest capture
                    </Button>
                  ) : null}
                </div>
              </section>
            ) : null}
            {capture ? <GameCaptureImage capture={capture} label="Editor viewport" /> : null}
            {data?.compileMessages.length ? (
              <ul aria-label="Build messages" className="space-y-1">
                {Array.from(
                  new Map(
                    data.compileMessages.map((message) => [compileMessageKey(message), message]),
                  ),
                ).map(([key, message]) => (
                  <li key={key}>
                    {message.severity} ·{" "}
                    {message.file ? `${message.file}:${message.line ?? 1} · ` : ""}
                    {message.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
        {tab === "timeline" ? (
          <>
            <h3 className="font-medium">Playtest Timeline</h3>
            {capture ? <GameCaptureImage capture={capture} label="Playtest capture" /> : null}
            <ol className="space-y-2">
              {data?.timeline.toReversed().map((entry) => (
                <li className="border-b pb-2" key={entry.id}>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString()}</time>
                    <span>{entry.kind}</span>
                    {entry.playtest === null ? null : <span>Playtest {entry.playtest}</span>}
                  </div>
                  <p className="break-words">{entry.text}</p>
                  {entry.captureId ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void showCapture(entry.captureId!)}
                    >
                      View capture
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
            {data?.timeline.length === 0 ? <p>No editor events yet.</p> : null}
          </>
        ) : null}
        {tab === "checkpoints" && data ? (
          <CheckpointList
            environmentId={environmentId}
            projectRoot={projectRoot}
            checkpoints={data.checkpoints}
            refresh={query.refresh}
          />
        ) : null}
        {tab === "assets" ? (
          <AssetList
            environmentId={environmentId}
            projectRoot={projectRoot}
            connected={session?.state === "connected"}
          />
        ) : null}
        {tab === "recipes" && engine ? (
          <RecipeList engine={engine} onUseRecipe={onUseRecipe} />
        ) : null}
        {tab === "recipes" && !engine ? (
          <p>Connect an editor or open a game project to use a recipe.</p>
        ) : null}
      </div>
    </div>
  );
}

function CheckpointList({
  environmentId,
  projectRoot,
  checkpoints,
  refresh,
}: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly projectRoot: string;
  readonly checkpoints: GameDevWorkspace["checkpoints"];
  readonly refresh: () => void;
}) {
  const create = useAtomCommand(gameDevEnvironment.checkpointCreate, { reportFailure: false });
  const diff = useAtomCommand(gameDevEnvironment.checkpointDiff, { reportFailure: false });
  const restore = useAtomCommand(gameDevEnvironment.checkpointRestore, { reportFailure: false });
  const canCreate = useAtomValue(gameDevEnvironment.checkpointCreate.permissionAtom(environmentId));
  const canDiff = useAtomValue(gameDevEnvironment.checkpointDiff.permissionAtom(environmentId));
  const canRestore = useAtomValue(
    gameDevEnvironment.checkpointRestore.permissionAtom(environmentId),
  );
  const [label, setLabel] = useState("");
  const [changes, setChanges] = useState<GameCheckpointDiff | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = async (task: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    await (async () => {
      await task();
    })().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "The checkpoint action failed.");
    });
    setBusy(false);
  };
  return (
    <section aria-label="Game project checkpoints" className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canCreate || busy || !label.trim()) return;
          void apply(async () => {
            const result = await create({
              environmentId,
              input: { projectRoot, label: label.trim() },
            });
            if (result._tag === "Success") {
              setLabel("");
              refresh();
            } else setMessage(resultError(result));
          });
        }}
      >
        <Input
          aria-label="Checkpoint name"
          placeholder="Checkpoint name"
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
        <Button type="submit" size="sm" disabled={busy || !canCreate || !label.trim()}>
          Create checkpoint
        </Button>
      </form>
      {message ? <p role="status">{message}</p> : null}
      {checkpoints.map((checkpoint) => (
        <div className="space-y-1 rounded-md border p-2" key={checkpoint.checkpointId}>
          <strong>{checkpoint.label}</strong>
          <p className="text-xs text-muted-foreground">
            {new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.createdBy}
          </p>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !canDiff}
              onClick={() =>
                void apply(async () => {
                  const result = await diff({
                    environmentId,
                    input: { projectRoot, checkpointId: checkpoint.checkpointId },
                  });
                  if (result._tag === "Success") setChanges(result.value);
                  else setMessage(resultError(result));
                })
              }
            >
              View diff
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !canRestore}
              onClick={() =>
                void apply(async () => {
                  if (
                    !(await requestConfirmDialog(
                      `Restore “${checkpoint.label}”? This replaces the covered files with the checkpoint versions.`,
                      { variant: "destructive" },
                    ))
                  )
                    return;
                  const result = await restore({
                    environmentId,
                    input: { projectRoot, checkpointId: checkpoint.checkpointId },
                  });
                  setMessage(
                    result._tag === "Success" ? "Checkpoint restored." : resultError(result),
                  );
                  if (result._tag === "Success") {
                    setChanges(null);
                    refresh();
                  }
                })
              }
            >
              Restore
            </Button>
          </div>
          {changes?.checkpoint.checkpointId === checkpoint.checkpointId ? (
            <div className="space-y-2">
              {changes.changes.length === 0 ? <p>No changes.</p> : null}
              {changes.changes.map((change) => (
                <details key={change.path}>
                  <summary>
                    {change.change} · {change.path}
                  </summary>
                  {change.diff ? (
                    <pre className="overflow-auto text-xs">{change.diff}</pre>
                  ) : (
                    <p>Text comparison unavailable.</p>
                  )}
                </details>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function AssetList({
  environmentId,
  projectRoot,
  connected,
}: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly projectRoot: string;
  readonly connected: boolean;
}) {
  const assets = useEnvironmentQuery(
    gameDevEnvironment.assets({ environmentId, input: { projectRoot } }),
  );
  const preview = useAtomCommand(gameDevEnvironment.assetPreview, { reportFailure: false });
  const importAsset = useAtomCommand(gameDevEnvironment.assetImport, { reportFailure: false });
  const canImport = useAtomValue(gameDevEnvironment.assetImport.permissionAtom(environmentId));
  const [selected, setSelected] = useState<{
    readonly assetId: string;
    readonly revision: number;
    readonly image: GameDevCapture | null;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const show = async (assetId: string, revision: number) => {
    setBusy(true);
    setMessage(null);
    const result = await preview({ environmentId, input: { projectRoot, assetId, revision } });
    setBusy(false);
    if (result._tag === "Success") setSelected({ assetId, revision, image: result.value });
    else setMessage(resultError(result));
  };
  const add = async (assetId: string, revision: number) => {
    setBusy(true);
    setMessage(null);
    await (async () => {
      const input = { projectRoot, assetId, revision };
      let result = await importAsset({ environmentId, input });
      if (result._tag === "Success" && result.value.replaceRequired) {
        if (selected?.assetId !== assetId || selected.revision !== revision || !selected.image)
          return setMessage(result.value.replaceRequired);
        if (!(await requestConfirmDialog(result.value.replaceRequired))) return;
        result = await importAsset({ environmentId, input: { ...input, confirmReplace: true } });
      }
      setMessage(
        result._tag === "Success"
          ? (result.value.replaceRequired ?? result.value.import.status)
          : resultError(result),
      );
      assets.refresh();
    })().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "The asset could not be imported.");
    });
    setBusy(false);
  };
  return (
    <section aria-label="Game assets" className="space-y-2">
      <Button size="xs" variant="ghost" onClick={assets.refresh}>
        Refresh assets
      </Button>
      {message || assets.error ? <p role="status">{message ?? assets.error}</p> : null}
      {assets.data?.length === 0 ? <p>No asset revisions yet.</p> : null}
      {assets.data?.map((asset) => (
        <details className="rounded-md border p-2" key={asset.assetId}>
          <summary>
            {asset.name} · {asset.kind}
            {asset.activeRevision === null ? "" : ` · active revision ${asset.activeRevision}`}
          </summary>
          <ul className="mt-2 space-y-3">
            {asset.revisions.toReversed().map((item) => (
              <li key={item.revision} className="space-y-1">
                <p>
                  Revision {item.revision}
                  {item.note ? ` · ${item.note}` : ""}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void show(asset.assetId, item.revision)}
                  >
                    Preview
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || !canImport || !connected}
                    onClick={() => void add(asset.assetId, item.revision)}
                  >
                    Import
                  </Button>
                </div>
                {selected?.assetId === asset.assetId && selected.revision === item.revision ? (
                  selected.image ? (
                    <GameCaptureImage
                      capture={selected.image}
                      label={`${asset.name} revision ${item.revision}`}
                    />
                  ) : (
                    <p>No preview available.</p>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

function RecipeList({
  engine,
  onUseRecipe,
}: {
  readonly engine: GameDevWorkspace["projects"][number]["engine"];
  readonly onUseRecipe: (prompt: string) => void;
}) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  return (
    <section aria-label="Game development recipes" className="space-y-2">
      {GAME_RECIPES.map((recipe) => (
        <div key={recipe.id} className="space-y-2 rounded-md border p-2">
          <strong>{recipe.title}</strong>
          <p className="text-muted-foreground">{recipe.summary}</p>
          {recipe.input ? (
            <Input
              aria-label={recipe.input.label}
              placeholder={recipe.input.placeholder}
              value={inputs[recipe.id] ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setInputs((current) => ({ ...current, [recipe.id]: value }));
              }}
            />
          ) : null}
          <Button
            size="xs"
            variant="outline"
            onClick={() => onUseRecipe(recipePrompt(recipe, engine, inputs[recipe.id] ?? ""))}
          >
            Add to composer
          </Button>
        </div>
      ))}
    </section>
  );
}
