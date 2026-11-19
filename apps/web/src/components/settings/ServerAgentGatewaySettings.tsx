import { msg } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { agentGatewayStatusLabel, type GatewayScope } from "@t3tools/client-runtime/gateway";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type AgentGatewayStatus, type EnvironmentId } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { MCP_GATEWAY_CONFIGURABLE_SCOPES, MCP_GATEWAY_SCOPE_LABELS } from "../../mcpGatewayState";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { APP_NAME } from "@t3tools/shared/branding";

/** Each connected server's own gateway, which runs there without a desktop app. */
export function ServerAgentGatewaySettings({
  includeDesktopHosted,
}: {
  /** In the desktop app its own environment is configured above, so its row is noise. */
  readonly includeDesktopHosted: boolean;
}) {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.agentGateway === true,
  );
  if (supported.length === 0 && includeDesktopHosted) {
    return (
      <SettingsRow
        title="Server gateway"
        description="Update a connected server to turn on its gateway here, or use the gateway in the installed desktop app."
        status="No connected server supports it."
      />
    );
  }
  return supported.map((environment) => (
    <ServerAgentGatewayRow
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={environment.label}
      includeDesktopHosted={includeDesktopHosted}
    />
  ));
}

/** The gateway status of one environment's server, for surfaces outside Settings. */
export function useServerAgentGatewayStatus(environmentId: EnvironmentId) {
  return AsyncResult.getOrElse(
    useAtomValue(serverEnvironment.agentGateway({ environmentId, input: {} })),
    () => null,
  );
}

function ServerAgentGatewayRow({
  environmentId,
  label,
  includeDesktopHosted,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly includeDesktopHosted: boolean;
}) {
  const status = useServerAgentGatewayStatus(environmentId);
  const allowed = useAtomValue(serverEnvironment.updateAgentGateway.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateAgentGateway);
  const reveal = useAtomCommand(serverEnvironment.revealAgentGatewayToken);
  const rotate = useAtomCommand(serverEnvironment.rotateAgentGatewayToken);
  const [pending, setPending] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "gateway token",
      unavailableMessage: msg("Clipboard API is unavailable while copying gateway token."),
      failureMessage: msg("Failed to copy gateway token to the clipboard."),
    },
  });
  if (status === null || (status.host === "desktop" && !includeDesktopHosted)) return null;

  const run = async <A, E>(
    action: string,
    command: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<A | null> => {
    setPending(true);
    const result = await command();
    setPending(false);
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not ${action} on ${label}`,
        description: String(squashAtomCommandFailure(result)),
      });
    }
    return null;
  };
  const target = (input: Parameters<typeof update>[0]["input"]) => ({ environmentId, input });
  const setScopes = (scopes: ReadonlyArray<GatewayScope>) =>
    void run("change gateway access", () => update(target({ scopes: [...scopes] })));
  const disabled = !allowed || pending || status.host === "desktop";

  return (
    <SettingsRow
      title={`Server gateway on ${label}`}
      description={`Runs on that server without the desktop app: MCP hosts on its machine drive this environment with the access below, and ${APP_NAME} events and webhooks keep flowing.`}
      status={`Status: ${agentGatewayStatusLabel(status)}${status.problem ? `. ${status.problem}` : ""}`}
      control={
        <Switch
          checked={status.enabled}
          disabled={disabled}
          aria-label={`Enable server gateway on ${label}`}
          onCheckedChange={(checked) =>
            void run("change the gateway", () => update(target({ enabled: Boolean(checked) })))
          }
        />
      }
    >
      {status.host === "server" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <ScopesMenu
              label={label}
              scopes={status.scopes}
              disabled={disabled}
              onChange={setScopes}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={async () => {
                const value = await run("show the gateway token", () =>
                  reveal({ environmentId, input: {} }),
                );
                if (value !== null) setToken(value.token);
              }}
            >
              Show token
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={async () => {
                const value = await run("rotate the gateway token", () =>
                  rotate({ environmentId, input: {} }),
                );
                if (value !== null) setToken(value.token);
              }}
            >
              Rotate token
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {status.scopes.map((scope) => MCP_GATEWAY_SCOPE_LABELS[scope]).join(", ")}. MCP
            launchers on that machine connect to ws://127.0.0.1:{status.port} with the token, which
            the server keeps in ~/.config/t3code/mcp-gateway.env. Rotating it disconnects them.
          </p>
          {token !== null ? (
            <div className="flex items-center gap-2">
              <Input readOnly value={token} aria-label={`Gateway token for ${label}`} />
              <Button size="sm" variant="outline" onClick={() => copyToClipboard(token)}>
                {isCopied ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setToken(null)}>
                Hide
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsRow>
  );
}

function ScopesMenu({
  label,
  scopes,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly scopes: AgentGatewayStatus["scopes"];
  readonly disabled: boolean;
  readonly onChange: (scopes: ReadonlyArray<GatewayScope>) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={<Button variant="outline" size="sm" aria-label={`Gateway access for ${label}`} />}
      >
        <span className="min-w-0 truncate">
          {scopes.length} of {MCP_GATEWAY_CONFIGURABLE_SCOPES.length} capabilities
        </span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-64">
        {MCP_GATEWAY_CONFIGURABLE_SCOPES.map((scope) => (
          <MenuCheckboxItem
            key={scope}
            checked={scopes.includes(scope)}
            // Without read an outside agent can do nothing, so the server refuses it.
            disabled={scope === "read" && scopes.includes("read")}
            onCheckedChange={(checked) =>
              onChange(
                checked ? [...scopes, scope] : scopes.filter((candidate) => candidate !== scope),
              )
            }
          >
            {MCP_GATEWAY_SCOPE_LABELS[scope]}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
