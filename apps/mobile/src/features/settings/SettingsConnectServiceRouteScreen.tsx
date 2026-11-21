import {
  discoverSelfHostedRelay,
  type SelfHostedRelay,
} from "@t3tools/client-runtime/relay/self-hosted";
import { reloadAppAsync } from "expo";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import * as Dialog from "../../components/ui/Dialog";
import { readSelfHostedRelay, saveSelfHostedRelay } from "../cloud/publicConfig";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

// Sign-in and the relay client are wired once at startup, so a new choice reloads the app.
async function switchTo(relay: SelfHostedRelay | null) {
  await saveSelfHostedRelay(relay);
  await reloadAppAsync("Switched the T3 Connect service");
}

/** Chooses between the build's T3 Connect and a relay the user runs themselves. */
export function SettingsConnectServiceRouteScreen() {
  const gt = useGT();
  const current = readSelfHostedRelay();
  const [selfHosted, setSelfHosted] = useState(current !== null);
  const [address, setAddress] = useState(current?.relayUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (next: () => Promise<SelfHostedRelay | null>) => {
    setError(null);
    setBusy(true);
    try {
      await switchTo(await next());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not reach the relay."));
      setBusy(false);
    }
  };

  return (
    <SettingsScreen title={gt("T3 Connect service")}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-6 px-5 pt-4">
        <SettingsSection>
          <ListChoiceRow
            label={gt("T3 Connect")}
            description={gt("Links your devices through T3's relay.")}
            selected={!selfHosted}
            disabled={busy}
            onPress={() => {
              setSelfHosted(false);
              setError(null);
            }}
          />
          <ListChoiceRow
            label={gt("Self-hosted relay")}
            description={gt("Your own relay and sign-in provider.")}
            selected={selfHosted}
            separated
            disabled={busy}
            onPress={() => setSelfHosted(true)}
          />
        </SettingsSection>
        {selfHosted ? (
          <View className="gap-2">
            <TextInput
              accessibilityLabel={gt("Relay address")}
              className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
              placeholderTextColorClassName="accent-foreground-muted"
              placeholder="relay.example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!busy}
              value={address}
              onChangeText={setAddress}
            />
            <Text textRole="footnote" className="text-foreground-muted">
              {current
                ? gt("Using {relay}. Sign-in details are read from the relay.", {
                    relay: current.relayUrl,
                  })
                : gt(
                    "Sign-in details are read from the relay. Signing in starts over after the switch.",
                  )}
            </Text>
            {error ? (
              <Text accessibilityRole="alert" className="text-danger-foreground">
                {error}
              </Text>
            ) : null}
            <View className="flex-row justify-end">
              <ControlPill
                variant="primary"
                label={busy ? gt("Checking…") : current ? gt("Update") : gt("Use relay")}
                disabled={busy || address.trim() === ""}
                onPress={() => void run(() => discoverSelfHostedRelay(address))}
              />
            </View>
          </View>
        ) : current ? (
          <View className="flex-row justify-end">
            <ControlPill
              variant="primary"
              label={gt("Use T3 Connect")}
              disabled={busy}
              onPress={() =>
                Dialog.confirm({
                  title: gt("Switch back to T3 Connect?"),
                  message: gt(
                    "Sign-in starts over, and environments linked to your relay stay there until you link them again.",
                  ),
                  confirmText: gt("Switch"),
                  onConfirm: () => void run(async () => null),
                })
              }
            />
          </View>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
