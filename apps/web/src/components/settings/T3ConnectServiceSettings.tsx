import {
  discoverSelfHostedRelay,
  type SelfHostedRelay,
} from "@t3tools/client-runtime/relay/self-hosted";
import { useState } from "react";

import { useCloudAuth } from "~/cloud/cloudAuth";
import { readSelfHostedRelay, saveSelfHostedRelay } from "~/cloud/publicConfig";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type Service = "default" | "self-hosted";

const SERVICE_LABELS: Record<Service, string> = {
  default: "T3 Connect",
  "self-hosted": "Self-hosted relay",
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// Sign-in and the relay client are wired once at startup, so a new choice reloads the app.
const switchTo = (relay: SelfHostedRelay | null) => {
  saveSelfHostedRelay(relay);
  window.location.reload();
};

/** Chooses between the build's T3 Connect and a relay the user runs themselves. */
export function T3ConnectServiceSettings() {
  const current = readSelfHostedRelay();
  const { isSignedIn, openAccount } = useCloudAuth();
  const [service, setService] = useState<Service>(current ? "self-hosted" : "default");
  const [address, setAddress] = useState(current?.relayUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const connect = async () => {
    setError(null);
    setIsChecking(true);
    try {
      switchTo(await discoverSelfHostedRelay(address));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the relay.");
      setIsChecking(false);
    }
  };

  return (
    <SettingsSection {...searchableSetting("t3-connect-service")}>
      <SettingsRow
        title="Service"
        description={
          current
            ? `Using the relay at ${current.relayUrl}, signing in through ${hostOf(current.oidcIssuer)}.`
            : "T3 Connect links your devices through T3's relay. Choose a self-hosted relay to use your own server and sign-in provider."
        }
        control={
          <Select
            value={service}
            onValueChange={(value) => {
              if (value === null) return;
              setService(value);
              setError(null);
            }}
          >
            <SelectTrigger size="xs" className="w-40" aria-label="T3 Connect service">
              <SelectValue>{SERVICE_LABELS[service]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(SERVICE_LABELS) as Array<Service>).map((value) => (
                <SelectItem key={value} value={value}>
                  {SERVICE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {service === "self-hosted" ? (
        <SettingsRow
          title="Relay address"
          description="Sign-in details are read from the relay. Signing in starts over after the switch."
          status={error}
          control={
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              <Input
                size="sm"
                className="w-56"
                aria-label="Relay address"
                placeholder="relay.example.com"
                value={address}
                disabled={isChecking}
                onChange={(event) => setAddress(event.target.value)}
              />
              <Button type="submit" size="xs" disabled={isChecking || address.trim() === ""}>
                {isChecking ? "Checking…" : current ? "Update" : "Use relay"}
              </Button>
            </form>
          }
        />
      ) : null}
      {current && isSignedIn && openAccount ? (
        <SettingsRow
          title="Linked environments"
          description="Environments linked to your relay account. Deregister one you no longer use."
          control={
            <Button size="xs" variant="outline" onClick={() => openAccount()}>
              Manage
            </Button>
          }
        />
      ) : null}
      {service !== "self-hosted" && current ? (
        <SettingsRow
          title="Switch back to T3 Connect"
          description="Sign-in starts over, and environments linked to your relay stay there until you link them again."
          control={
            <Button size="xs" variant="outline" onClick={() => switchTo(null)}>
              Use T3 Connect
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
