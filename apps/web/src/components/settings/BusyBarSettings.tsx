import type { BusyBarSettings as BusyBarSettingsValue, EnvironmentId } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/** Agent alerts on a BUSY Bar, configured per environment because the server drives the device. */
export function BusyBarSettingsSection() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" && environment.serverConfig !== null
      ? environment.environmentId
      : null;

  return (
    <SettingsSection id="busy-bar" title="BUSY Bar">
      {environmentId ? (
        // Drafts belong to one environment; switching must not carry them over.
        <BusyBarControls key={environmentId} environmentId={environmentId} />
      ) : (
        <SettingsRow
          {...searchableSetting("busy-bar-alerts")}
          description="Connect to an environment to set up a BUSY Bar."
        />
      )}
    </SettingsSection>
  );
}

function BusyBarControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.busyBar);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save BUSY Bar settings",
  });
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const address = (addressDraft ?? saved.address).trim();
  const newToken = token.trim();
  const canSave = address.length > 0 && (address !== saved.address || newToken.length > 0);

  const save = async (patch: Partial<BusyBarSettingsValue>) => {
    setSaving(true);
    try {
      const result = await updateSettings({ environmentId, input: { patch: { busyBar: patch } } });
      if (result._tag === "Success") {
        setAddressDraft(null);
        setToken("");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("busy-bar-alerts")}
      description="Show finished and failed runs, approvals, and questions on a BUSY Bar this server can reach."
      control={
        <Switch
          checked={saved.enabled}
          disabled={saving}
          aria-label="Show agent alerts on BUSY Bar"
          onCheckedChange={(checked) => void save({ enabled: Boolean(checked) })}
        />
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void save({ address, ...(newToken ? { token: newToken } : {}) });
        }}
      >
        {/* Locked while saving: a successful save clears the drafts, which would drop edits made mid-request. */}
        <fieldset disabled={saving} className="contents">
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Use <code>10.0.4.20</code> over USB, the device's IP on Wi-Fi with its HTTP access
            password, or <code>api.busy.app</code> with a cloud API token.{" "}
            <InlineButton
              render={
                <a
                  href="https://docs.busy.app/bar/dev/http-api"
                  target="_blank"
                  rel="noreferrer noopener"
                />
              }
            >
              Learn more
              <ExternalLinkIcon aria-hidden className="size-3" />
            </InlineButton>
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor={`busy-bar-address-${environmentId}`}>Address</Label>
            <Input
              id={`busy-bar-address-${environmentId}`}
              autoComplete="off"
              size="sm"
              placeholder="10.0.4.20"
              value={addressDraft ?? saved.address}
              onChange={(event) => setAddressDraft(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`busy-bar-token-${environmentId}`}>Password or API token</Label>
            <Input
              id={`busy-bar-token-${environmentId}`}
              type="password"
              autoComplete="off"
              size="sm"
              placeholder={
                saved.token ? "Stored secret, enter a new value to replace" : "Not needed over USB"
              }
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            {saved.token ? (
              <Button size="xs" variant="outline" onClick={() => void save({ token: "" })}>
                Remove token
              </Button>
            ) : null}
            <Button type="submit" size="xs" disabled={!canSave}>
              Save
            </Button>
          </div>
        </fieldset>
      </form>
    </SettingsRow>
  );
}
