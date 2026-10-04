import type {
  BusyBarSettings as BusyBarSettingsValue,
  BusyBarStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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

const CONNECTED_LABEL: Record<BusyBarStatus["connection"], string> = {
  usb: "Connected over USB",
  lan: "Connected over Wi-Fi",
  cloud: "Connected via BUSY Cloud",
};

function busyBarStatusLabel(status: BusyBarStatus, address: string) {
  if (status.state === "connected") return CONNECTED_LABEL[status.connection];
  if (status.state === "unauthorized") {
    return status.connection === "cloud"
      ? "BUSY Cloud rejected the API token"
      : `The BUSY Bar at ${address} rejected the password`;
  }
  return `Can't reach a BUSY Bar at ${address}`;
}

/**
 * The status line for the saved device, probed while alerts are on. Each mount
 * and `recheck` asks the server again; null `label` means nothing to show.
 */
function useBusyBarStatus(environmentId: EnvironmentId, saved: BusyBarSettingsValue) {
  const query = useEnvironmentQuery(
    saved.enabled ? serverEnvironment.busyBarStatus({ environmentId, input: {} }) : null,
  );
  const settled = !query.isPending && (query.data !== null || query.error !== null);
  return {
    label: !saved.enabled
      ? null
      : !settled
        ? "Checking…"
        : query.data
          ? busyBarStatusLabel(query.data, saved.address)
          : query.error,
    failed: settled && query.data?.state !== "connected",
    recheck: query.refresh,
  };
}

function BusyBarControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.busyBar);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save BUSY Bar settings",
  });
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const status = useBusyBarStatus(environmentId, saved);
  const address = (addressDraft ?? saved.address).trim();
  const newToken = token.trim();
  const canSave = address.length > 0 && (address !== saved.address || newToken.length > 0);

  const save = async (patch: Partial<BusyBarSettingsValue>) => {
    setSaving(true);
    try {
      const result = await updateSettings({ environmentId, input: { patch: { busyBar: patch } } });
      if (result._tag !== "Success") return false;
      setAddressDraft(null);
      setToken("");
      return true;
    } finally {
      setSaving(false);
    }
  };
  // Turning alerts on mounts the probe; connection edits while on need a recheck.
  const saveConnection = async (patch: Partial<BusyBarSettingsValue>) => {
    if (await save(patch)) status.recheck();
  };

  return (
    <SettingsRow
      {...searchableSetting("busy-bar-alerts")}
      description="Show finished and failed runs, approvals, and questions on a BUSY Bar this server can reach."
      status={
        status.failed ? (
          <span className="block text-destructive">{status.label}</span>
        ) : (
          status.label
        )
      }
      control={
        <Switch
          checked={saved.enabled}
          disabled={saving}
          aria-label="Send events to BUSY Bar"
          onCheckedChange={(checked) => void save({ enabled: Boolean(checked) })}
        />
      }
    >
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          Connection
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform duration-200 group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <form
            className="grid gap-4 pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave)
                void saveConnection({ address, ...(newToken ? { token: newToken } : {}) });
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
                    saved.token
                      ? "Stored secret, enter a new value to replace"
                      : "Not needed over USB"
                  }
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2">
                {saved.token ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void saveConnection({ token: "" })}
                  >
                    Remove token
                  </Button>
                ) : null}
                <Button type="submit" size="xs" disabled={!canSave}>
                  Save
                </Button>
              </div>
            </fieldset>
          </form>
        </CollapsiblePanel>
      </Collapsible>
    </SettingsRow>
  );
}
