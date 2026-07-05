import { useCallback, useState } from "react";
import { SquareKanbanIcon } from "lucide-react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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

  const handleSave = useCallback(async () => {
    const trimmed = token.trim();
    if (environmentId === null || trimmed.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await setToken({ environmentId, input: { token: trimmed } });
      if (result._tag === "Success" && result.value.status === "authenticated") {
        setTokenValue("");
        authQuery.refresh();
        toastManager.add({
          type: "success",
          title: "Linear connected",
          description: result.value.account
            ? `Connected as ${result.value.account.name}.`
            : "Linear is now connected.",
        });
      } else {
        const detail =
          result._tag === "Success"
            ? (result.value.detail ?? "Linear rejected the token.")
            : "The token could not be saved.";
        toastManager.add({ type: "error", title: "Could not connect Linear", description: detail });
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
    </SettingsPageContainer>
  );
}
