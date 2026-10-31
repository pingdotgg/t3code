import { useAtomValue } from "@effect/atom-react";
import type { LinearConnectionStatus } from "@t3tools/contracts";
import { CheckIcon, ExternalLinkIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironments } from "../../state/environments";
import { linearEnvironment } from "../../state/linear";
import { classifyLinearFailure } from "@t3tools/client-runtime/linear/degradation";
import { LinearAvatar, LinearGlyph, LinearTeamBadge } from "../linear/linearIcons";
import {
  useLinearCommands,
  useLinearEnvironmentId,
  useLinearStatus,
} from "../linear/useLinearData";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LinearLaunchSettings } from "./LinearLaunchSettings";
import { LinearMappingSettings } from "./LinearMappingSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const LINEAR_KEY_URL = "https://linear.app/settings/account/security";

const CONNECT_BULLETS = [
  "Browse your teams, projects and milestones in the Linear tab",
  "Launch a chat or pipeline with the issue attached as context",
  "Optionally move issues to In Progress and comment a link back to the thread",
] as const;

function connectFailureMessage(failure: unknown): string {
  switch (classifyLinearFailure(failure)) {
    case "unauthorized":
      return "Linear rejected this key.";
    case "unavailable":
    case "rate_limited":
      return "Couldn't reach Linear. Try again in a moment.";
    default:
      return failure instanceof Error && failure.message.length > 0
        ? failure.message
        : "Couldn't connect to Linear.";
  }
}

export function LinearSettingsPanel() {
  const status = useLinearStatus();
  const state = status.data?.state ?? null;
  const environmentId = useLinearEnvironmentId();
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return (
    <SettingsPageContainer>
      {environments.length > 1 && environment ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Linear settings apply to {environment.label}.
        </p>
      ) : null}
      {state === null ? (
        <SettingsSection {...searchableSetting("linear")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {status.error ?? "Checking the Linear connection..."}
          </p>
        </SettingsSection>
      ) : state === "connected" && status.data !== null ? (
        <>
          <LinearConnectedCard status={status.data} />
          <LinearMappingSettings status={status.data} />
          <LinearLaunchSettings status={status.data} />
        </>
      ) : (
        <LinearConnectCard reconnect={state === "invalid"} />
      )}
    </SettingsPageContainer>
  );
}

function ConnectionBadge({ state }: { readonly state: LinearConnectionStatus["state"] }) {
  if (state === "connected") {
    return (
      <Badge variant="success" size="default">
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        Connected
      </Badge>
    );
  }
  return (
    <Badge variant={state === "invalid" ? "warning" : "outline"}>
      {state === "invalid" ? "Key no longer valid" : "Not connected"}
    </Badge>
  );
}

function useLinearDisconnect() {
  const commands = useLinearCommands();
  const [disconnecting, setDisconnecting] = useState(false);
  const canDisconnect = useAtomValue(
    linearEnvironment.disconnect.permissionAtom(commands.environmentId),
  );
  const disconnect = async () => {
    const message =
      "Disconnect Linear? The API key is deleted from the server. Your project mappings and launch history are kept.";
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setDisconnecting(true);
    const result = await commands.disconnect();
    setDisconnecting(false);
    if (result !== null && result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not disconnect Linear" });
    }
  };
  return { disconnect, disconnecting, canDisconnect };
}

/** Disconnected, or connected with a key Linear no longer accepts. */
function LinearConnectCard({ reconnect }: { readonly reconnect: boolean }) {
  const commands = useLinearCommands();
  const canConnect = useAtomValue(linearEnvironment.connect.permissionAtom(commands.environmentId));
  const { disconnect, disconnecting, canDisconnect } = useLinearDisconnect();
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const key = apiKey.trim();
    if (key.length === 0 || pending) return;
    setPending(true);
    setError(null);
    const result = await commands.connect(key);
    setPending(false);
    if (result === null) {
      setError("Couldn't reach this environment.");
    } else if (result._tag === "Failure") {
      setError(connectFailureMessage(squashAtomCommandFailure(result)));
    } else {
      // The key now lives on the server; keep nothing of it in the page.
      setApiKey("");
    }
  };

  return (
    <SettingsSection
      {...searchableSetting("linear")}
      headerAction={<ConnectionBadge state={reconnect ? "invalid" : "disconnected"} />}
    >
      <div className="flex items-start gap-3.5 px-4 py-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <LinearGlyph className="size-5" />
        </span>
        <div className="min-w-0 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {reconnect ? "Reconnect Linear" : "Connect your Linear workspace"}
            </h3>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              Start chats and pipelines straight from Linear issues. T3 Code pulls the issue, its
              sub-issues and comments into context, and can update the issue as work progresses.
            </p>
          </div>
          {reconnect ? (
            <p role="alert" className="text-xs font-medium text-warning-foreground">
              Your Linear API key is no longer valid. Paste a new key.
            </p>
          ) : (
            <ul className="space-y-1.5 text-xs text-foreground">
              {CONNECT_BULLETS.map((bullet) => (
                <li key={bullet} className="flex items-center gap-2">
                  <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
                  {bullet}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <form
        className="space-y-2 px-4 py-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label
          className="flex items-center gap-1.5 text-xs font-medium text-foreground"
          htmlFor="linear-api-key"
        >
          <KeyRoundIcon aria-hidden className="size-3.5 text-muted-foreground" />
          Personal API key
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="linear-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="lin_api_..."
            value={apiKey}
            disabled={pending || !canConnect}
            aria-invalid={error !== null}
            onChange={(event) => {
              setApiKey(event.target.value);
              setError(null);
            }}
            className="max-w-sm flex-1"
          />
          <Button
            type="submit"
            size="sm"
            disabled={pending || !canConnect || apiKey.trim().length === 0}
          >
            {pending ? <Spinner size="sm" /> : null}
            Verify &amp; save
          </Button>
          {reconnect ? (
            <Button
              type="button"
              size="sm"
              variant="ghost-destructive"
              disabled={disconnecting || !canDisconnect}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
        {error !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          <a
            href={LINEAR_KEY_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
          >
            Create a key in Linear
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
          <span className="ms-2">
            Stored in the server&apos;s secret store. Keys inherit your Linear permissions.
          </span>
        </p>
      </form>
    </SettingsSection>
  );
}

function LinearConnectedCard({ status }: { readonly status: LinearConnectionStatus }) {
  const commands = useLinearCommands();
  const canResync = useAtomValue(linearEnvironment.resync.permissionAtom(commands.environmentId));
  const { disconnect, disconnecting, canDisconnect } = useLinearDisconnect();
  const [resyncing, setResyncing] = useState(false);

  const resync = async () => {
    setResyncing(true);
    const result = await commands.resync();
    setResyncing(false);
    if (result !== null && result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not resync Linear" });
    }
  };

  const { organization, viewer } = status;
  return (
    <SettingsSection
      {...searchableSetting("linear")}
      headerAction={<ConnectionBadge state="connected" />}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <LinearGlyph className="size-5" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                {organization?.name ?? "Linear workspace"}
              </h3>
              {organization ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {organization.urlKey}
                </span>
              ) : null}
              <Badge variant="outline" size="sm">
                Personal API key
              </Badge>
            </div>
            {viewer ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <LinearAvatar user={viewer} className="size-4" />
                Signed in as {viewer.name}
                {viewer.email ? ` (${viewer.email})` : ""}
              </p>
            ) : null}
            {status.teams.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
                <span>Teams visible</span>
                {status.teams.map((team) => (
                  <Tooltip key={team.id}>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex">
                          <LinearTeamBadge teamKey={team.key} color={team.color} />
                        </span>
                      }
                    />
                    <TooltipPopup side="top">{team.name}</TooltipPopup>
                  </Tooltip>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={resyncing || disconnecting || !canResync}
            onClick={() => void resync()}
          >
            {resyncing ? <Spinner size="sm" /> : <RefreshCwIcon aria-hidden />}
            Resync
          </Button>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={resyncing || disconnecting || !canDisconnect}
            onClick={() => void disconnect()}
          >
            Disconnect
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
