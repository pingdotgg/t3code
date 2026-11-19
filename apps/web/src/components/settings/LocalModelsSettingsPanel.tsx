import {
  OllamaModelName,
  type EnvironmentId,
  type OllamaInstallEvent,
  type OllamaInstalledModel,
  type OllamaPullEvent,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  OLLAMA_MODEL_CATALOG,
  assessOllamaModelFit,
  ollamaModelSupportsAgents,
  type OllamaFit,
} from "@t3tools/shared/ollamaCatalog";
import * as Schema from "effect/Schema";
import { CpuIcon, DownloadIcon, PlayIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { ollamaEnvironment } from "../../state/ollama";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  formatBytes,
  hardwareSummary,
  installStageLabel,
  ollamaStatusSummary,
  progressPercent,
} from "./LocalModelsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const isModelName = Schema.is(OllamaModelName);

function failureText(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Ollama did not respond. Check that it is running.";
}

const FIT_BADGE: Record<
  OllamaFit,
  { label: string; variant: "success" | "info" | "warning" | "error" }
> = {
  gpu: { label: "Runs on GPU", variant: "success" },
  partial: { label: "GPU + CPU", variant: "info" },
  cpu: { label: "CPU only", variant: "warning" },
  insufficient: { label: "Not enough memory", variant: "error" },
};

function ProgressBar({ percent }: { readonly percent: number | null }) {
  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent ?? undefined}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
    >
      <div
        className="h-full rounded-full bg-primary"
        style={{ width: `${percent ?? 8}%`, opacity: percent === null ? 0.5 : 1 }}
      />
    </div>
  );
}

interface PullState {
  readonly event: OllamaPullEvent | null;
  readonly error: string | null;
}

export function LocalModelsSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <Alert>
          <AlertDescription>
            Local models run on the computer that runs Continuum. Open this page from the desktop
            app or from that computer's own address.
          </AlertDescription>
        </Alert>
      </SettingsPageContainer>
    );
  }
  return <LocalModelsSettingsContent environmentId={environmentId} />;
}

function LocalModelsSettingsContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const searchableSetting = useSearchableSetting();
  const startOllama = useAtomCommand(ollamaEnvironment.start, { reportFailure: false });
  const installOllama = useAtomCommand(ollamaEnvironment.install, { reportFailure: false });
  const pullModel = useAtomCommand(ollamaEnvironment.pull, { reportFailure: false });
  const deleteModel = useAtomCommand(ollamaEnvironment.deleteModel, { reportFailure: false });
  const setAgentIntegration = useAtomCommand(ollamaEnvironment.setAgentIntegration, {
    reportFailure: false,
  });

  const overviewQuery = useEnvironmentQuery(
    ollamaEnvironment.overview({ environmentId, input: {} }),
  );
  const overview = overviewQuery.data;
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? overviewQuery.error;
  const [busy, setBusy] = useState<"start" | "install" | "agents" | null>(null);
  const [installEvent, setInstallEvent] = useState<OllamaInstallEvent | null>(null);
  const [pulls, setPulls] = useState<Readonly<Record<string, PullState>>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState("");

  const refresh = () => {
    setError(null);
    overviewQuery.refresh();
  };

  const status = overview?.status ?? null;
  const installed = new Map((overview?.models ?? []).map((model) => [model.name, model]));

  const onStart = async () => {
    setBusy("start");
    const result = await startOllama({ environmentId, input: {} });
    setBusy(null);
    if (result._tag !== "Success") setError(failureText(result));
    refresh();
  };

  const onInstall = async () => {
    setBusy("install");
    setInstallEvent(null);
    const result = await installOllama({
      environmentId,
      input: { input: {}, onEvent: (event) => setInstallEvent(event) },
    });
    setBusy(null);
    setInstallEvent(null);
    if (result._tag !== "Success") setError(failureText(result));
    refresh();
  };

  const onPull = async (model: string) => {
    setPulls((current) => ({ ...current, [model]: { event: null, error: null } }));
    const result = await pullModel({
      environmentId,
      input: {
        input: { model },
        onEvent: (event) =>
          setPulls((current) => ({ ...current, [model]: { event, error: null } })),
      },
    });
    setPulls((current) => {
      const rest = Object.fromEntries(Object.entries(current).filter(([key]) => key !== model));
      return result._tag === "Success"
        ? rest
        : { ...rest, [model]: { event: null, error: failureText(result) } };
    });
    refresh();
  };

  const onDelete = async (model: string) => {
    setConfirmDelete(null);
    const result = await deleteModel({ environmentId, input: { model } });
    if (result._tag !== "Success") setError(failureText(result));
    refresh();
  };

  const onToggleAgents = async (enabled: boolean) => {
    setBusy("agents");
    const result = await setAgentIntegration({ environmentId, input: { enabled } });
    setBusy(null);
    if (result._tag !== "Success") setError(failureText(result));
    refresh();
  };

  const onSubmitCustom = (event: FormEvent) => {
    event.preventDefault();
    const name = customModel.trim();
    if (!isModelName(name)) return;
    setCustomModel("");
    void onPull(name);
  };

  const agentModels = (overview?.models ?? []).filter(ollamaModelSupportsAgents);

  return (
    <SettingsPageContainer>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection
        id="local-models"
        title="Ollama"
        icon={<CpuIcon className="size-4" />}
        headerAction={
          <Button disabled={overviewQuery.isPending} onClick={refresh} size="xs" variant="ghost">
            <RefreshCwIcon />
            Refresh
          </Button>
        }
      >
        <SettingsRow
          {...searchableSetting("setting-ollama-runtime")}
          description={
            status === null
              ? "Checking for Ollama…"
              : busy === "install"
                ? `${installStageLabel(installEvent)}. This is a large download (about 1.5 GB) and can take a while.`
                : ollamaStatusSummary(status)
          }
          control={
            status === null ? null : status.reachable ? (
              <Badge variant="success">Running</Badge>
            ) : status.managedInstalled ? (
              <Button disabled={busy !== null} onClick={() => void onStart()} size="sm">
                <PlayIcon />
                {busy === "start" ? "Starting…" : "Start Ollama"}
              </Button>
            ) : status.canInstall ? (
              <Button disabled={busy !== null} onClick={() => void onInstall()} size="sm">
                <DownloadIcon />
                {busy === "install" ? "Installing…" : "Install Ollama"}
              </Button>
            ) : null
          }
        >
          {busy === "install" && installEvent?.type === "progress" ? (
            <div className="flex items-center gap-3 pt-2">
              <ProgressBar
                percent={progressPercent(installEvent.completedBytes, installEvent.totalBytes)}
              />
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatBytes(installEvent.completedBytes)} / {formatBytes(installEvent.totalBytes)}
              </span>
            </div>
          ) : null}
        </SettingsRow>

        <SettingsRow
          {...searchableSetting("setting-ollama-agents")}
          description={
            status?.agentIntegrationEnabled
              ? `"Ollama (local)" is in the model picker with ${agentModels.length} tool-calling model${agentModels.length === 1 ? "" : "s"}, run by Codex's agent, which Continuum installs when needed.`
              : 'Adds an "Ollama (local)" agent to the model picker. Local models that support tool calling then run commands and edit files through Codex\'s agent, like any other model.'
          }
          control={
            <Switch
              aria-label="Use local models in agents"
              checked={status?.agentIntegrationEnabled ?? false}
              disabled={status === null || busy !== null}
              onCheckedChange={(checked) => void onToggleAgents(checked)}
            />
          }
        />

        {overview ? (
          <SettingsRow
            {...searchableSetting("setting-ollama-hardware")}
            description={hardwareSummary(overview.hardware)}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection id="local-models-installed" title="Installed models">
        {overview && overview.models.length === 0 ? (
          <SettingsRow
            title="No models yet"
            description="Download one from the library below. Models are stored by Ollama and shared with any other app that uses it."
          />
        ) : null}
        {(overview?.models ?? []).map((model) => (
          <InstalledModelRow
            key={model.name}
            confirming={confirmDelete === model.name}
            model={model}
            onCancel={() => setConfirmDelete(null)}
            onDelete={() =>
              confirmDelete === model.name
                ? void onDelete(model.name)
                : setConfirmDelete(model.name)
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection id="local-models-library" title="Model library">
        {OLLAMA_MODEL_CATALOG.map((entry) => {
          const fit = overview
            ? assessOllamaModelFit(entry.downloadBytes, overview.hardware)
            : null;
          const pull = pulls[entry.name];
          const isInstalled = installed.has(entry.name);
          return (
            <SettingsRow
              key={entry.name}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {entry.title}
                  <span className="font-mono text-xs text-muted-foreground">{entry.name}</span>
                  {fit ? (
                    <Badge variant={FIT_BADGE[fit.fit].variant}>{FIT_BADGE[fit.fit].label}</Badge>
                  ) : null}
                </span>
              }
              description={
                <>
                  {entry.description}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {entry.publisher} · {entry.parameters} parameters · about{" "}
                    {formatBytes(entry.downloadBytes)} download ·{" "}
                    {Math.round(entry.contextTokens / 1024)}K context · tool calling
                    {fit ? ` · ${fit.summary}` : ""}
                  </span>
                </>
              }
              control={
                isInstalled ? (
                  <Badge variant="secondary">Installed</Badge>
                ) : (
                  <Button
                    disabled={
                      !status?.reachable || (pull?.event !== undefined && pull.error === null)
                    }
                    onClick={() => void onPull(entry.name)}
                    size="sm"
                    variant="outline"
                  >
                    <DownloadIcon />
                    {pull && pull.error === null ? "Downloading…" : "Download"}
                  </Button>
                )
              }
            >
              <PullProgress state={pull} />
            </SettingsRow>
          );
        })}
        <SettingsRow
          {...searchableSetting("setting-ollama-custom-model")}
          description="Any model from the Ollama library, such as mistral-small3.2:24b. Only models with tool calling can drive agents."
          control={
            <form className="flex w-full gap-2 sm:w-80" onSubmit={onSubmitCustom}>
              <Input
                aria-label="Model name"
                onChange={(event) => setCustomModel(event.currentTarget.value)}
                placeholder="model:tag"
                value={customModel}
              />
              <Button
                disabled={!status?.reachable || !isModelName(customModel.trim())}
                size="sm"
                type="submit"
              >
                Download
              </Button>
            </form>
          }
        >
          {Object.entries(pulls)
            .filter(([name]) => !OLLAMA_MODEL_CATALOG.some((entry) => entry.name === name))
            .map(([name, state]) => (
              <div className="pt-2" key={name}>
                <span className="font-mono text-xs">{name}</span>
                <PullProgress state={state} />
              </div>
            ))}
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function PullProgress({ state }: { readonly state: PullState | undefined }) {
  if (state === undefined) return null;
  if (state.error) {
    return <p className="pt-2 text-xs text-destructive-foreground">{state.error}</p>;
  }
  const event = state.event;
  const percent =
    event?.type === "progress" ? progressPercent(event.completedBytes, event.totalBytes) : null;
  return (
    <div className="flex items-center gap-3 pt-2">
      <ProgressBar percent={percent} />
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {event?.type === "progress"
          ? percent === null
            ? event.status || "Starting…"
            : `${percent}% of ${formatBytes(event.totalBytes)}`
          : "Starting…"}
      </span>
    </div>
  );
}

function InstalledModelRow({
  model,
  confirming,
  onDelete,
  onCancel,
}: {
  readonly model: OllamaInstalledModel;
  readonly confirming: boolean;
  readonly onDelete: () => void;
  readonly onCancel: () => void;
}) {
  const agentReady = ollamaModelSupportsAgents(model);
  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{model.name}</span>
          <Badge variant={agentReady ? "success" : "warning"}>
            {agentReady ? "Tool calling" : "Chat only"}
          </Badge>
        </span>
      }
      description={[
        formatBytes(model.sizeBytes),
        model.parameterSize,
        model.quantization,
        model.contextLength ? `${Math.round(model.contextLength / 1024)}K context` : null,
        agentReady ? null : "cannot drive agents (no tool calling)",
      ]
        .filter(Boolean)
        .join(" · ")}
      control={
        <div className="flex gap-2">
          {confirming ? (
            <Button onClick={onCancel} size="sm" variant="ghost">
              Cancel
            </Button>
          ) : null}
          <Button
            aria-label={`Delete ${model.name}`}
            onClick={onDelete}
            size="sm"
            variant={confirming ? "destructive" : "outline"}
          >
            <Trash2Icon />
            {confirming ? "Delete" : null}
          </Button>
        </div>
      }
    />
  );
}
