import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GameDevOverview,
  GameEngineStatus,
  GameInstallEvent,
  GameInstallerPlan,
} from "@t3tools/contracts";
import { Fragment, type FormEvent, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { gameDevEnvironment } from "../../state/gameDev";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function installProgress(event: GameInstallEvent | null): string {
  if (event === null) return "Preparing installation…";
  if (event.type === "plan") return event.plan.title;
  if (event.type !== "progress") return event.message;
  if (event.totalBytes && event.completedBytes !== null) {
    return `${event.stage} · ${Math.round((100 * event.completedBytes) / event.totalBytes)}%`;
  }
  return event.stage;
}

function resultError(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : "The environment could not complete the request.";
}

export function GameDevelopmentSettingsPanel() {
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<string | null>(null);
  const environment =
    environments.find((candidate) => candidate.environmentId === (selected ?? primary)) ??
    environments[0];
  return (
    <SettingsPageContainer>
      <SettingsSection id="game-development" title="Game Development">
        <SettingsRow
          title="Environment"
          description="Editors and asset tools run on this machine."
          control={
            <select
              aria-label="Game development environment"
              value={environment?.environmentId ?? ""}
              onChange={(event) => setSelected(event.currentTarget.value)}
            >
              {environments.map((entry) => (
                <option key={entry.environmentId} value={entry.environmentId}>
                  {entry.label}
                </option>
              ))}
            </select>
          }
        />
      </SettingsSection>
      {environment ? (
        <GameDevelopmentContent
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p>Connect an environment to manage its editors.</p>
      )}
    </SettingsPageContainer>
  );
}

function GameDevelopmentContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const overview = useEnvironmentQuery(gameDevEnvironment.overview({ environmentId, input: {} }));
  const data = overview.data;
  return (
    <>
      <SettingsSection
        title={data?.host.label ?? "Editors"}
        headerAction={
          <Button size="sm" variant="outline" onClick={overview.refresh}>
            Refresh
          </Button>
        }
      >
        <SettingsRow
          title="Editor bridge"
          description={
            data?.bridge.error ??
            (data?.bridge.listening
              ? `Listening on port ${data.bridge.port} on this environment`
              : "Waiting for the environment")
          }
        />
      </SettingsSection>
      {overview.error ? (
        <Alert variant="error">
          <AlertDescription>{overview.error}</AlertDescription>
        </Alert>
      ) : null}
      {data?.engines.map((engine) => (
        <Fragment key={engine.engine}>
          <EngineCard engine={engine} environmentId={environmentId} refresh={overview.refresh} />
          {engine.engine === "roblox" ? (
            <AssetToolSettings
              overview={data}
              environmentId={environmentId}
              refresh={overview.refresh}
            />
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

function InstallControl({
  plan,
  environmentId,
  refresh,
}: {
  readonly plan: GameInstallerPlan;
  readonly environmentId: EnvironmentId;
  readonly refresh: () => void;
}) {
  const install = useAtomCommand(gameDevEnvironment.install, { reportFailure: false });
  const canInstall = useAtomValue(gameDevEnvironment.install.permissionAtom(environmentId));
  const [event, setEvent] = useState<GameInstallEvent | null>(null);
  const [version, setVersion] = useState("");
  const [revision, setRevision] = useState("");
  const unityVersionRequired =
    plan.target === "unity" && plan.kind === "vendor-launcher" && !plan.version;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const automatic =
    plan.kind === "download-and-run" ||
    plan.kind === "download-and-open" ||
    plan.kind === "download-and-extract" ||
    plan.kind === "vendor-launcher";
  const start = async () => {
    setBusy(true);
    setError(null);
    setEvent(null);
    const result = await install({
      environmentId,
      input: {
        input: {
          target: plan.target,
          ...(plan.version || version.trim() ? { version: plan.version ?? version.trim() } : {}),
          ...(revision.trim() ? { revision: revision.trim() } : {}),
        },
        onEvent: setEvent,
      },
    });
    if (result._tag !== "Success") setError(resultError(result));
    setBusy(false);
    refresh();
  };
  const handoff =
    event?.type === "handoff" ? event.url : plan.kind === "browser-handoff" ? plan.url : null;
  return (
    <div className="space-y-2">
      <p className="font-medium">{plan.title}</p>
      <p className="text-muted-foreground">
        {plan.source}
        {plan.note ? ` · ${plan.note}` : ""}
      </p>
      {plan.steps.length > 0 ? (
        <ol className="list-decimal space-y-1 ps-5">
          {plan.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
      {plan.commands.length > 0 ? (
        <pre className="overflow-auto rounded bg-muted p-2">{plan.commands.join("\n")}</pre>
      ) : null}
      {unityVersionRequired ? (
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Unity version to install"
            placeholder="Unity version (e.g. 6000.0.60f1)"
            value={version}
            onChange={(event) => setVersion(event.currentTarget.value)}
          />
          <Input
            aria-label="Unity changeset"
            placeholder="Changeset (optional)"
            value={revision}
            onChange={(event) => setRevision(event.currentTarget.value)}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {automatic ? (
          <Button
            size="sm"
            disabled={busy || !canInstall || (unityVersionRequired && !version.trim())}
            onClick={() => void start()}
          >
            Install
          </Button>
        ) : null}
        {handoff ? (
          <a href={handoff} target="_blank" rel="noreferrer" className="text-primary underline">
            Open vendor page
          </a>
        ) : null}
        {busy || event ? <span role="status">{installProgress(event)}</span> : null}
      </div>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function LocateTool({
  target,
  environmentId,
  refresh,
}: {
  readonly target: GameInstallerPlan["target"];
  readonly environmentId: EnvironmentId;
  readonly refresh: () => void;
}) {
  const locate = useAtomCommand(gameDevEnvironment.locate, { reportFailure: false });
  const allowed = useAtomValue(gameDevEnvironment.locate.permissionAtom(environmentId));
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!allowed || !path.trim()) return;
    const result = await locate({ environmentId, input: { target, path: path.trim() } });
    if (result._tag !== "Success") return setError(resultError(result));
    setError(null);
    setPath("");
    refresh();
  };
  return (
    <form className="space-y-2" onSubmit={(event) => void onSubmit(event)}>
      <div className="flex gap-2">
        <Input
          aria-label={`${target} executable path`}
          placeholder="Executable path on the environment"
          value={path}
          onChange={(event) => setPath(event.currentTarget.value)}
        />
        <Button size="sm" type="submit" variant="outline" disabled={!allowed || path.trim() === ""}>
          Locate
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function EngineCard({
  engine,
  environmentId,
  refresh,
}: {
  readonly engine: GameEngineStatus;
  readonly environmentId: EnvironmentId;
  readonly refresh: () => void;
}) {
  const open = useAtomCommand(gameDevEnvironment.openProject, { reportFailure: false });
  const bind = useAtomCommand(gameDevEnvironment.bindSession, { reportFailure: false });
  const canOpen = useAtomValue(gameDevEnvironment.openProject.permissionAtom(environmentId));
  const canBind = useAtomValue(gameDevEnvironment.bindSession.permissionAtom(environmentId));
  const [projectRoot, setProjectRoot] = useState("");
  const [editorPath, setEditorPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const launch = async () => {
    setBusy(true);
    await (async () => {
      const input = {
        engine: engine.engine,
        projectRoot: projectRoot.trim(),
        ...(editorPath ? { editorPath } : {}),
      };
      let result = await open({ environmentId, input });
      if (result._tag === "Success" && result.value.upgradeRequired) {
        if (!(await requestConfirmDialog(result.value.upgradeRequired.message))) return;
        result = await open({ environmentId, input: { ...input, confirmUpgrade: true } });
      }
      setMessage(result._tag === "Success" ? result.value.message : resultError(result));
      refresh();
    })().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "The editor could not start.");
    });
    setBusy(false);
  };
  const connect = async (sessionId: string) => {
    const result = await bind({
      environmentId,
      input: { sessionId, projectRoot: projectRoot.trim() },
    });
    setMessage(result._tag === "Success" ? "Editor connected." : resultError(result));
    refresh();
  };
  return (
    <SettingsSection
      title={engine.displayName}
      headerAction={
        <Badge variant={engine.availability === "local" ? "success" : "secondary"}>
          {engine.availability === "local"
            ? "Local"
            : engine.availability === "remote-only"
              ? "Remote only"
              : "Unavailable"}
        </Badge>
      }
    >
      <SettingsRow title="Availability" description={engine.availabilityReason} />
      <SettingsRow
        title="Versions"
        description={
          engine.recommendedVersion ? `Recommended ${engine.recommendedVersion}` : undefined
        }
      >
        <ul className="space-y-1">
          {engine.installs.map((install) => (
            <li key={install.path}>
              {install.version} · {install.source} ·{" "}
              <span className="break-all font-mono text-xs">{install.path}</span>
            </li>
          ))}
        </ul>
        {engine.installs.length === 0 ? <p>No editor detected.</p> : null}
        {engine.launcher ? (
          <p>
            Launcher {engine.launcher.version} · {engine.launcher.path}
          </p>
        ) : null}
      </SettingsRow>
      {engine.availability === "local" ? (
        <SettingsRow title="Setup and launch">
          <div className="space-y-4">
            {engine.launcherInstaller && !engine.launcher ? (
              <InstallControl
                plan={engine.launcherInstaller}
                environmentId={environmentId}
                refresh={refresh}
              />
            ) : null}
            <InstallControl
              plan={engine.installer}
              environmentId={environmentId}
              refresh={refresh}
            />
            <LocateTool target={engine.engine} environmentId={environmentId} refresh={refresh} />
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label={`${engine.displayName} project folder`}
                placeholder="Project folder on the environment"
                value={projectRoot}
                onChange={(event) => setProjectRoot(event.currentTarget.value)}
              />
              <select
                aria-label={`${engine.displayName} version to launch`}
                value={editorPath}
                onChange={(event) => setEditorPath(event.currentTarget.value)}
              >
                <option value="">Project version</option>
                {engine.installs.map((install) => (
                  <option key={install.path} value={install.path}>
                    {install.version}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                onClick={() => void launch()}
                disabled={!canOpen || busy || !projectRoot.trim() || engine.installs.length === 0}
              >
                Launch and connect
              </Button>
            </div>
          </div>
        </SettingsRow>
      ) : null}
      <SettingsRow
        title="Editor connections"
        description={engine.sessions.length === 0 ? "No editor sessions" : undefined}
      >
        {engine.sessions.map((session) => (
          <div key={session.sessionId} className="flex flex-wrap items-center gap-2 py-1">
            <span>
              {session.projectName} · {session.state}
            </span>
            {session.projectRoot ? (
              <span className="break-all font-mono text-xs">{session.projectRoot}</span>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={!canBind || !projectRoot.trim() || session.state !== "connected"}
                onClick={() => void connect(session.sessionId)}
              >
                Bind to project
              </Button>
            )}
          </div>
        ))}
        {message ? <p role="status">{message}</p> : null}
      </SettingsRow>
    </SettingsSection>
  );
}

function AssetToolSettings({
  overview,
  environmentId,
  refresh,
}: {
  readonly overview: GameDevOverview;
  readonly environmentId: EnvironmentId;
  readonly refresh: () => void;
}) {
  const saveKey = useAtomCommand(gameDevEnvironment.setForgeGuiKey, { reportFailure: false });
  const test = useAtomCommand(gameDevEnvironment.testForgeGui, { reportFailure: false });
  const update = useAtomCommand(gameDevEnvironment.updateSettings, { reportFailure: false });
  const canSave = useAtomValue(gameDevEnvironment.setForgeGuiKey.permissionAtom(environmentId));
  const canTest = useAtomValue(gameDevEnvironment.testForgeGui.permissionAtom(environmentId));
  const canUpdate = useAtomValue(gameDevEnvironment.updateSettings.permissionAtom(environmentId));
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const blender = overview.tools.find((tool) => tool.tool === "blender");
  const forgeGui = overview.tools.find((tool) => tool.tool === "forgegui");
  const save = async (apiKey: string | null) => {
    const result = await saveKey({ environmentId, input: { apiKey } });
    if (result._tag === "Success") setKey("");
    setMessage(
      result._tag === "Success"
        ? apiKey === null
          ? "API key removed."
          : "API key saved."
        : resultError(result),
    );
    refresh();
  };
  const testConnection = async () => {
    const result = await test({ environmentId, input: {} });
    setMessage(result._tag === "Success" ? result.value.message : resultError(result));
  };
  return (
    <SettingsSection title="Roblox asset tools">
      {blender ? (
        <SettingsRow
          title="Blender"
          description={
            blender.installed
              ? `${blender.installed.version} · ${blender.installed.path}`
              : blender.detail
          }
        >
          <div className="space-y-3">
            {blender.installer ? (
              <InstallControl
                plan={blender.installer}
                environmentId={environmentId}
                refresh={refresh}
              />
            ) : null}
            <LocateTool target="blender" environmentId={environmentId} refresh={refresh} />
          </div>
        </SettingsRow>
      ) : null}
      {forgeGui ? (
        <SettingsRow
          title="ForgeGUI for Roblox"
          description={forgeGui.configured ? "API key saved on the environment." : forgeGui.detail}
        >
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (key.trim() && canSave) void save(key.trim());
            }}
          >
            <Input
              aria-label="ForgeGUI API key"
              type="password"
              value={key}
              onChange={(event) => setKey(event.currentTarget.value)}
            />
            <Button size="sm" type="submit" disabled={!canSave || !key.trim()}>
              Save API key
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={!canTest || !forgeGui.configured}
              onClick={() => void testConnection()}
            >
              Test connection
            </Button>
            {forgeGui.configured ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                disabled={!canSave}
                onClick={() => void save(null)}
              >
                Remove key
              </Button>
            ) : null}
          </form>
          {message ? <p role="status">{message}</p> : null}
        </SettingsRow>
      ) : null}
      <SettingsRow
        title="Allow ForgeGUI publishing"
        description="Each upload still requires your approval."
        control={
          <Switch
            aria-label="Allow ForgeGUI publishing"
            checked={overview.settings.allowForgeGuiPublishing}
            disabled={!canUpdate}
            onCheckedChange={(enabled) => {
              void update({ environmentId, input: { allowForgeGuiPublishing: enabled } }).then(
                (result) => {
                  if (result._tag !== "Success") setMessage(resultError(result));
                  refresh();
                },
              );
            }}
          />
        }
      />
    </SettingsSection>
  );
}
