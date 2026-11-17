import { useAtomValue } from "@effect/atom-react";
import type { BoatCloudSetup, BoxdCloudMachine } from "@t3tools/contracts";
import { useState } from "react";
import { Linking, View } from "react-native";

import { BoxdIcon } from "../../components/BoxdIcon";
import { Button } from "../../components/ui/Button";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { SecretTextInput } from "../../components/ui/SecretTextInput";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { StepGlyph, type StepState } from "../boatCloud/BoatCloudSteps";
import { boatCloudSnapshotRepositories } from "../boatCloud/phoneBoatCloud";
import { SettingsSection } from "../settings/components/SettingsSection";
import { boxdCloudHoldersAtom } from "./boxdCloud";

const SETUP_STEPS = ["create-vm", "install-server", "save-snapshot"] as const;

const STEP_LABELS: Record<(typeof SETUP_STEPS)[number], string> = {
  "create-vm": "Create a machine",
  "install-server": "Install T3 Code and clone repositories",
  "save-snapshot": "Save the T3 Code snapshot",
};

const MACHINE_STATE_LABELS: Record<BoxdCloudMachine["state"], string> = {
  running: "Running",
  asleep: "Asleep",
  stopped: "Stopped",
};

function stepState(setup: BoatCloudSetup, index: number): StepState {
  if (setup.status === "ready") return "done";
  if (setup.step === null || setup.status === "idle") return "pending";
  const current = SETUP_STEPS.findIndex((step) => step === setup.step);
  if (index < current) return "done";
  if (index > current) return "pending";
  return setup.status === "failed" ? "failed" : "active";
}

function Separated(props: { readonly index: number; readonly children: React.ReactNode }) {
  return (
    <View className={cn(props.index > 0 && "border-t border-border-subtle")}>{props.children}</View>
  );
}

/** boxd cloud on the Cloud settings screen. A connected machine holds the key, never the phone. */
export function BoxdCloudSettingsSections() {
  const holders = useAtomValue(boxdCloudHoldersAtom);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const connect = useAtomCommand(serverEnvironment.connectBoxdCloud, "Connect boxd");
  const disconnect = useAtomCommand(serverEnvironment.disconnectBoxdCloud, "Disconnect boxd");
  const runSetup = useAtomCommand(serverEnvironment.runBoxdCloudSetup, "Set up boxd cloud");
  const holder = holders.find((candidate) => candidate.status.connected) ?? holders[0];
  if (!holder) return null;
  const { environmentId, status } = holder;
  const { connected, setup } = status;
  const setUp = () =>
    runSetup({ environmentId, input: { repositories: boatCloudSnapshotRepositories() } });
  const submitKey = async (value: string) => {
    const key = value.trim();
    if (!key || busy) return;
    setBusy(true);
    const result = await connect({ environmentId, input: { apiKey: key } });
    setBusy(false);
    if (result._tag !== "Success") return;
    setApiKey("");
    if (result.value.setup.status === "idle") void setUp();
  };

  return (
    <>
      <SettingsSection title="boxd">
        {connected ? (
          <View>
            <ListRowLayout
              leading={<BoxdIcon size={22} colorClassName="accent-icon" />}
              label={status.account ?? "Connected"}
              description="Connected"
            />
            <View className="px-4 pb-4">
              <Button
                label="Disconnect"
                tone="danger"
                size="compact"
                onPress={() => void disconnect({ environmentId, input: {} })}
              />
            </View>
          </View>
        ) : (
          <View className="gap-3 p-4">
            <SecretTextInput
              accessibilityLabel="boxd API key"
              placeholder="boxd API key"
              value={apiKey}
              onChangeText={setApiKey}
              editable={!busy}
              onSubmitEditing={(value) => void submitKey(value)}
            />
            <Button
              label={busy ? "Connecting" : "Connect"}
              tone="primary"
              size="compact"
              disabled={busy || apiKey.trim() === ""}
              onPress={() => void submitKey(apiKey)}
            />
            <Button
              label="Create a key"
              tone="text"
              size="compact"
              onPress={() => void Linking.openURL("https://app.boxd.sh/keys")}
            />
          </View>
        )}
      </SettingsSection>

      {connected ? (
        <SettingsSection
          title="boxd setup"
          trailing={
            <Button
              label={
                setup.status === "running"
                  ? "Setting up"
                  : setup.status === "ready"
                    ? "Rebuild snapshot"
                    : setup.status === "failed"
                      ? "Retry"
                      : "Set up"
              }
              tone="text"
              size="compact"
              disabled={setup.status === "running"}
              onPress={() => void setUp()}
            />
          }
        >
          {SETUP_STEPS.map((step, index) => {
            const state = stepState(setup, index);
            return (
              <Separated key={step} index={index}>
                <ListRowLayout
                  leading={<StepGlyph state={state} />}
                  label={STEP_LABELS[step]}
                  description={state === "failed" ? (setup.error ?? undefined) : undefined}
                />
              </Separated>
            );
          })}
        </SettingsSection>
      ) : null}

      {connected && status.machines.length > 0 ? (
        <SettingsSection title="boxd machines">
          {status.machines.map((machine, index) => (
            <Separated key={machine.vmId} index={index}>
              <ListRowLayout
                label={machine.label}
                description={
                  machine.repositories.length > 0
                    ? machine.repositories
                        .map((repository) => repository.split("/").slice(1).join("/"))
                        .join(", ")
                    : undefined
                }
                detail={MACHINE_STATE_LABELS[machine.state]}
              />
            </Separated>
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}
