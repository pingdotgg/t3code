import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function AgentSecretVaults({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const vaults = useEnvironmentSettings(environmentId, (settings) => settings.agentSecretVaults);
  const update = useUpdateEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <SettingsSection
      {...setting("agent-secret-vaults")}
      headerAction={
        !readOnly ? (
          <Button size="xs" variant="outline" onClick={() => setEditing("")}>
            <T>Add agent vault</T>
          </Button>
        ) : null
      }
    >
      <p className="px-4 py-3 text-sm text-muted-foreground">
        <T>
          Share a 1Password vault with agents on this environment. Each vault uses its own read-only
          service-account token. Access is allowed or not; there are no approval prompts.
        </T>
      </p>
      {Object.keys(vaults).length === 0 ? (
        <SettingsRow title={gt("No vaults shared with agents.")} />
      ) : (
        Object.keys(vaults).map((name) => (
          <SettingsRow
            key={name}
            title={name}
            description={gt("Shared with agents on this environment")}
            control={
              !readOnly ? (
                <div className="flex gap-1">
                  <Button size="xs" variant="ghost" onClick={() => setEditing(name)}>
                    <T>Change token</T>
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => update({ agentSecretVaults: { [name]: null } })}
                  >
                    <T>Remove vault</T>
                  </Button>
                </div>
              ) : null
            }
          />
        ))
      )}
      {editing !== null && !readOnly ? (
        <VaultDialog
          environmentId={environmentId}
          name={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function VaultDialog({
  environmentId,
  name,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const update = useUpdateEnvironmentSettings(environmentId);
  const [vault, setVault] = useState(name);
  const [token, setToken] = useState("");
  const valid =
    vault.trim().length > 0 &&
    vault.length <= 128 &&
    !/[/?\x00-\x1f]/.test(vault) &&
    token.trim().length > 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {name ? gt("Change token for {name}", { name }) : gt("Share an agent vault")}
          </DialogTitle>
          <DialogDescription>
            <T>
              The token stays in this server's secret storage and is never returned to clients. Use
              a separate read-only service account restricted to this vault. Install the op CLI on
              the server.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="agent-vault-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid) return;
              update({ agentSecretVaults: { [vault.trim()]: { token: token.trim() } } });
              setToken("");
              onClose();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="agent-vault-name">
                <T>Vault name</T>
              </Label>
              <Input
                id="agent-vault-name"
                value={vault}
                disabled={name.length > 0}
                maxLength={128}
                onChange={(event) => setVault(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-vault-token">
                <T>Service-account token</T>
              </Label>
              <Input
                id="agent-vault-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button type="submit" form="agent-vault-form" disabled={!valid}>
            {name ? gt("Save token") : gt("Share vault")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
