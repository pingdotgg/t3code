import { useCallback, useState } from "react";
import { SquareKanbanIcon } from "lucide-react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePrimarySettings } from "../../hooks/useSettings";
import { linearEnvironment } from "../../state/linear";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const LINEAR_TOKEN_HELP_URL = "https://linear.app/settings/account/security";

export function LinearSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const authQuery = useEnvironmentQuery(
    environmentId === null ? null : linearEnvironment.authStatus({ environmentId, input: {} }),
  );
  const setToken = useAtomCommand(linearEnvironment.setToken, "linear set token");
  const clearToken = useAtomCommand(linearEnvironment.clearToken, "linear clear token");

  const [token, setTokenValue] = useState("");
  const [busy, setBusy] = useState(false);

  const status = authQuery.data;
  const connected = status?.status === "authenticated";

  const linear = usePrimarySettings((settings) => settings.linear);
  const updateServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "linear settings update",
  );
  // Send only the changed key(s). Sending the whole `linear` object would carry
  // `stateMappingByTeam` on every toggle, which the whole-map replacement would
  // then overwrite (wiping server-side per-team overrides).
  const setLinear = useCallback(
    (patch: {
      autoSync?: boolean;
      transitionOnStart?: boolean;
      transitionOnPrOpen?: boolean;
      transitionOnMerge?: boolean;
      postComments?: boolean;
    }) => {
      if (environmentId === null) return;
      void updateServerSettings({ environmentId, input: { patch: { linear: patch } } });
    },
    [environmentId, updateServerSettings],
  );

  const handleSave = useCallback(async () => {
    const trimmed = token.trim();
    if (environmentId === null || trimmed.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await setToken({ environmentId, input: { token: trimmed } });
      if (result._tag !== "Success") {
        toastManager.add({
          type: "error",
          title: "Could not save token",
          description: "The token could not be saved.",
        });
        return;
      }
      // The token was stored. Verification is a separate concern — a transient
      // outage shouldn't read as "connect failed".
      setTokenValue("");
      authQuery.refresh();
      if (result.value.status === "authenticated") {
        toastManager.add({
          type: "success",
          title: "Linear connected",
          description: result.value.account
            ? `Connected as ${result.value.account.name}.`
            : "Linear is now connected.",
        });
      } else {
        toastManager.add({
          type: "warning",
          title: "Token saved",
          description: result.value.detail ?? "Saved, but Linear couldn’t verify it right now.",
        });
      }
    } finally {
      setBusy(false);
    }
  }, [authQuery, busy, environmentId, setToken, token]);

  const handleDisconnect = useCallback(async () => {
    if (environmentId === null || busy) return;
    setBusy(true);
    try {
      await clearToken({ environmentId, input: {} });
      authQuery.refresh();
      toastManager.add({ type: "success", title: "Linear disconnected" });
    } finally {
      setBusy(false);
    }
  }, [authQuery, busy, clearToken, environmentId]);

  const statusBadge = authQuery.isPending ? (
    <Badge variant="outline">Checking…</Badge>
  ) : connected ? (
    <Badge variant="success">Connected</Badge>
  ) : (
    <Badge variant="outline">Not connected</Badge>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Linear" icon={<SquareKanbanIcon className="size-3.5" />}>
        <SettingsRow
          title="Connection"
          description={
            connected && status?.account
              ? `Authenticated as ${status.account.name}${
                  status.account.email ? ` (${status.account.email})` : ""
                }.`
              : "Connect Linear with a personal API key to import issues into new threads."
          }
          status={authQuery.error ?? status?.detail ?? null}
          control={
            <div className="flex items-center gap-2">
              {statusBadge}
              {connected ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={handleDisconnect}>
                  Disconnect
                </Button>
              ) : null}
            </div>
          }
        >
          {connected ? null : (
            <div className="flex flex-col gap-2 pt-3 pb-3.5">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="lin_api_…"
                  aria-label="Linear personal API key"
                  value={token}
                  disabled={environmentId === null || busy}
                  onChange={(event) => setTokenValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleSave();
                    }
                  }}
                />
                <Button
                  size="sm"
                  disabled={environmentId === null || busy || token.trim().length === 0}
                  onClick={() => void handleSave()}
                >
                  {busy ? "Connecting…" : "Connect"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground/80">
                Create a personal API key in{" "}
                <a
                  href={LINEAR_TOKEN_HELP_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Linear → Settings → Security &amp; access
                </a>
                . The key is stored securely on the server and never shown again.
              </p>
            </div>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Status write-back">
        <SettingsRow
          title="Auto-sync issue status"
          description="Move linked Linear issues as work progresses in T3 Code."
          control={
            <Switch
              checked={linear.autoSync}
              onCheckedChange={(checked) => setLinear({ autoSync: checked })}
              aria-label="Auto-sync issue status"
            />
          }
        />
        <SettingsRow
          title="In Progress on start"
          description="Set the issue to an In Progress state when the agent starts working."
          control={
            <Switch
              checked={linear.transitionOnStart}
              disabled={!linear.autoSync}
              onCheckedChange={(checked) => setLinear({ transitionOnStart: checked })}
              aria-label="Move to In Progress on start"
            />
          }
        />
        <SettingsRow
          title="In Review on pull request"
          description="Move the issue to In Review when a pull request opens for the thread."
          control={
            <Switch
              checked={linear.transitionOnPrOpen}
              disabled={!linear.autoSync}
              onCheckedChange={(checked) => setLinear({ transitionOnPrOpen: checked })}
              aria-label="Move to In Review on pull request"
            />
          }
        />
        <SettingsRow
          title="Done on merge"
          description="Complete the issue when its pull request is merged."
          control={
            <Switch
              checked={linear.transitionOnMerge}
              disabled={!linear.autoSync}
              onCheckedChange={(checked) => setLinear({ transitionOnMerge: checked })}
              aria-label="Move to Done on merge"
            />
          }
        />
        <SettingsRow
          title="Post progress comments"
          description="Comment on the issue when work starts. Off by default to reduce noise."
          control={
            <Switch
              checked={linear.postComments}
              disabled={!linear.autoSync}
              onCheckedChange={(checked) => setLinear({ postComments: checked })}
              aria-label="Post progress comments"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
