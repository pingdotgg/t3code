import {
  discoverSelfHostedRelay,
  type SelfHostedRelay,
} from "@t3tools/client-runtime/relay/self-hosted";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { useCloudAuth } from "~/cloud/cloudAuth";
import { readSelfHostedRelay, saveSelfHostedRelay } from "~/cloud/publicConfig";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

type Service = "default" | "self-hosted";

const SERVICE_LABELS = {
  default: msg("T3 Connect"),
  "self-hosted": msg("Self-hosted relay"),
} satisfies Record<Service, string>;

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
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
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
      setError(cause instanceof Error ? cause.message : gt("Could not reach the relay."));
      setIsChecking(false);
    }
  };

  return (
    <SettingsSection {...searchableSetting("t3-connect-service")}>
      <SettingsRow
        title={gt("Service")}
        description={
          current
            ? gt("Using the relay at {relay}, signing in through {issuer}.", {
                relay: current.relayUrl,
                issuer: hostOf(current.oidcIssuer),
              })
            : gt(
                "T3 Connect links your devices through T3's relay. Choose a self-hosted relay to use your own server and sign-in provider.",
              )
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
            <SelectTrigger size="xs" className="w-40" aria-label={gt("T3 Connect service")}>
              <SelectValue>{m(SERVICE_LABELS[service])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(SERVICE_LABELS) as Array<Service>).map((value) => (
                <SelectItem key={value} value={value}>
                  {m(SERVICE_LABELS[value])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {service === "self-hosted" ? (
        <SettingsRow
          title={gt("Relay address")}
          description={gt(
            "Sign-in details are read from the relay. Signing in starts over after the switch.",
          )}
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
                aria-label={gt("Relay address")}
                placeholder="relay.example.com"
                value={address}
                disabled={isChecking}
                onChange={(event) => setAddress(event.target.value)}
              />
              <Button type="submit" size="xs" disabled={isChecking || address.trim() === ""}>
                {isChecking ? gt("Checking…") : current ? gt("Update") : gt("Use relay")}
              </Button>
            </form>
          }
        />
      ) : null}
      {current && isSignedIn && openAccount ? (
        <SettingsRow
          title={gt("Linked environments")}
          description={gt(
            "Environments linked to your relay account. Deregister one you no longer use.",
          )}
          control={
            <Button size="xs" variant="outline" onClick={() => openAccount()}>
              <T>Manage</T>
            </Button>
          }
        />
      ) : null}
      {service !== "self-hosted" && current ? (
        <SettingsRow
          title={gt("Switch back to T3 Connect")}
          description={gt(
            "Sign-in starts over, and environments linked to your relay stay there until you link them again.",
          )}
          control={
            <Button size="xs" variant="outline" onClick={() => switchTo(null)}>
              <T>Use T3 Connect</T>
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
