import { connectionStatusText } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cloudEnvironmentProvider } from "~/cloud/cloudEnvironment";
import { maskedRenderServiceUrl, requestRenderPairing } from "~/cloud/renderBootstrap";
import { openCommandPalette } from "~/commandPaletteBus";
import { environmentCatalog } from "~/connection/catalog";
import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";
import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import { RenderLogo } from "../RenderLogo";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const RENDER_DEPLOY_URL =
  "https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fpingdotgg%2Ft3code%2Ftree%2Ffeat%2Frender-cloud-environment";
const CODEX_LOGIN_COMMAND = "codex login --device-auth";
type RenderAuthenticationMode = "api-key" | "subscription";

function CopyValueButton({ value, label }: { readonly value: string; readonly label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: label });
  return (
    <Button
      size="icon-sm"
      variant="outline"
      aria-label={`Copy ${label}`}
      onClick={() => copyToClipboard(value, undefined)}
    >
      {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

function CopyCommand({ command }: { readonly command: string }) {
  return (
    <div className="mt-2 flex min-w-0 items-start gap-2 rounded-lg border border-border/70 bg-muted/20 p-2">
      <code className="min-w-0 flex-1 overflow-x-auto py-1 text-xs text-foreground">{command}</code>
      <CopyValueButton value={command} label="command" />
    </div>
  );
}

function RenderEnvironmentRow({
  environment,
  busyEnvironmentIds,
  onConnect,
  onDisconnect,
}: {
  readonly environment: EnvironmentPresentation;
  readonly busyEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly onConnect: (environmentId: EnvironmentId) => void;
  readonly onDisconnect: (environmentId: EnvironmentId) => void;
}) {
  const isConnected = environment.connection.phase === "connected";
  const isBusy = busyEnvironmentIds.has(environment.environmentId);
  const serviceLabel = environment.displayUrl
    ? maskedRenderServiceUrl(environment.displayUrl)
    : null;
  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-2">
          <RenderLogo className="size-4" />
          {environment.label}
        </span>
      }
      description="Powered by Render"
      status={[connectionStatusText(environment.connection), serviceLabel]
        .filter(Boolean)
        .join(" · ")}
      control={
        <>
          {environment.displayUrl ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Open Render service"
              render={<a href={environment.displayUrl} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          ) : null}
          {isConnected ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              Add project
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={isBusy}
            onClick={() =>
              isConnected
                ? onDisconnect(environment.environmentId)
                : onConnect(environment.environmentId)
            }
          >
            {isBusy ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
            {isConnected ? "Disconnect" : "Connect"}
          </Button>
        </>
      }
    />
  );
}

export function CloudEnvironmentsSettings() {
  const { environments } = useEnvironments();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [serviceUrl, setServiceUrl] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairingStatus, setPairingStatus] = useState<string | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [busyEnvironmentIds, setBusyEnvironmentIds] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  const [authenticationMode, setAuthenticationMode] = useState<RenderAuthenticationMode>("api-key");
  const renderEnvironments = useMemo(
    () => environments.filter((environment) => cloudEnvironmentProvider(environment) === "render"),
    [environments],
  );
  const hasConnectedRenderEnvironment = renderEnvironments.some(
    (environment) => environment.connection.phase === "connected",
  );

  const reportFailure = useCallback((title: string, description: string) => {
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  }, []);

  const setEnvironmentBusy = useCallback((environmentId: EnvironmentId, busy: boolean) => {
    setBusyEnvironmentIds((current) => {
      const next = new Set(current);
      if (busy) next.add(environmentId);
      else next.delete(environmentId);
      return next;
    });
  }, []);

  const handlePair = useCallback(async () => {
    if (pairing) return;
    setPairError(null);
    setPairing(true);
    setPairingStatus("Waking the Render service…");
    try {
      const pairingInput = await requestRenderPairing({ serviceUrl });
      setServiceUrl(pairingInput.host);
      setPairingStatus("Connecting T3 Code…");
      const result = await connectPairing({
        host: pairingInput.host,
        pairingCode: pairingInput.pairingCode,
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setPairError(failure instanceof Error ? failure.message : "Could not pair environment.");
        }
        return;
      }
      toastManager.add({ type: "success", title: "Render environment connected" });
    } catch (error) {
      setPairError(error instanceof Error ? error.message : "Could not connect Render.");
    } finally {
      setPairing(false);
      setPairingStatus(null);
    }
  }, [connectPairing, pairing, serviceUrl]);

  const handleConnect = useCallback(
    async (environmentId: EnvironmentId) => {
      setEnvironmentBusy(environmentId, true);
      const result = await retryEnvironment(environmentId);
      setEnvironmentBusy(environmentId, false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        reportFailure(
          "Could not connect Render environment",
          failure instanceof Error ? failure.message : "Could not connect Render environment.",
        );
      }
    },
    [reportFailure, retryEnvironment, setEnvironmentBusy],
  );

  const handleDisconnect = useCallback(
    async (environmentId: EnvironmentId) => {
      setEnvironmentBusy(environmentId, true);
      const result = await removeEnvironment(environmentId);
      setEnvironmentBusy(environmentId, false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        reportFailure(
          "Could not disconnect Render environment",
          failure instanceof Error ? failure.message : "Could not disconnect Render environment.",
        );
      }
    },
    [removeEnvironment, reportFailure, setEnvironmentBusy],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("cloud-environments")}
        icon={<RenderLogo className="size-5" />}
      />

      <SettingsSection title="1. Deploy to Render">
        <div className="px-3 sm:px-4">
          <div
            role="tablist"
            aria-label="Codex authentication method"
            className="inline-flex rounded-lg border border-border/70 bg-muted/20 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={authenticationMode === "api-key"}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-xs"
              onClick={() => setAuthenticationMode("api-key")}
            >
              OpenAI API key
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={authenticationMode === "subscription"}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-xs"
              onClick={() => setAuthenticationMode("subscription")}
            >
              ChatGPT subscription
            </button>
          </div>
        </div>

        {authenticationMode === "api-key" ? (
          <div role="tabpanel">
            <SettingsRow
              title="OpenAI API key"
              description="Render asks for OPENAI_API_KEY. Codex is authenticated automatically when the service starts."
              status="OpenAI API usage is billed separately from Render."
              control={
                <Button
                  size="sm"
                  render={<a href={RENDER_DEPLOY_URL} target="_blank" rel="noreferrer" />}
                >
                  Deploy on Render
                  <ExternalLinkIcon className="size-3.5" />
                </Button>
              }
            />
          </div>
        ) : (
          <div role="tabpanel">
            <SettingsRow
              title="ChatGPT subscription"
              description="Leave OPENAI_API_KEY empty. After connecting and adding a project, run the command below in its T3 terminal."
              status="A free instance forgets this login whenever it restarts or spins down."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  render={<a href={RENDER_DEPLOY_URL} target="_blank" rel="noreferrer" />}
                >
                  Deploy on Render
                  <ExternalLinkIcon className="size-3.5" />
                </Button>
              }
            >
              <CopyCommand command={CODEX_LOGIN_COMMAND} />
            </SettingsRow>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="2. Connect in T3 Code">
        <SettingsRow
          title="Render service URL"
          description="Paste the .onrender.com URL shown at the top of the Render service. T3 Code pairs it here automatically."
          status={pairingStatus}
        >
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              value={serviceUrl}
              onChange={(event) => setServiceUrl(event.target.value)}
              placeholder="https://your-service.onrender.com"
              autoComplete="url"
              spellCheck={false}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !pairing) void handlePair();
              }}
            />
            <Button
              disabled={pairing || serviceUrl.trim().length === 0}
              onClick={() => void handlePair()}
            >
              {pairing ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
              Connect environment
            </Button>
          </div>
          {pairError ? <p className="mt-2 text-xs text-destructive">{pairError}</p> : null}
        </SettingsRow>
        {renderEnvironments.map((environment) => (
          <RenderEnvironmentRow
            key={environment.environmentId}
            environment={environment}
            busyEnvironmentIds={busyEnvironmentIds}
            onConnect={(environmentId) => void handleConnect(environmentId)}
            onDisconnect={(environmentId) => void handleDisconnect(environmentId)}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="3. Add a project">
        <SettingsRow
          title="Clone a public GitHub repository"
          description="Paste a GitHub URL and T3 Code clones it into the Render workspace, ready for an agent."
          status={hasConnectedRenderEnvironment ? "Render is ready" : "Connect Render first"}
          control={
            <Button
              size="sm"
              disabled={!hasConnectedRenderEnvironment}
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              Add project
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
