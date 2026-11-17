import { useAtomValue } from "@effect/atom-react";
import {
  BOAT_CLOUD_REQUIRED_SCOPES,
  BOAT_CLOUD_SETUP_STEPS,
  type BoatCloudEnvironmentAccess,
  type BoatCloudMachine,
  type BoatCloudSetup,
  type BoatCloudSetupStep,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BoatIcon } from "../../components/BoatIcon";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SecretTextInput } from "../../components/ui/SecretTextInput";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { boatCloudHoldersAtom, boatCloudOutdatedMachinesAtom } from "../boatCloud/boatCloud";
import { StepGlyph, type StepState } from "../boatCloud/BoatCloudSteps";
import { BoxdCloudSettingsSections } from "../boxdCloud/BoxdCloudSettingsSections";
import {
  configurePhoneBoatCloudEnvironment,
  connectPhoneBoatCloud,
  disconnectPhoneBoatCloud,
  phoneBoatCloudAtom,
  readPhoneBoatCloudKey,
  refreshPhoneBoatCloud,
  boatCloudSnapshotRepositories,
  runPhoneBoatCloudSetup,
} from "../boatCloud/phoneBoatCloud";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const STEP_LABELS: Record<BoatCloudSetupStep, string> = {
  "create-vm": "Create a VM",
  "install-server": "Install T3 Code and clone repositories",
  "copy-skills": "Copy this machine's skills",
  "save-snapshot": "Save the T3 Code snapshot",
};

const ACCESS_LABELS: Record<keyof BoatCloudEnvironmentAccess, string> = {
  passGithub: "GitHub access",
  passSandboxCredentials: "Boat credentials",
  passSecrets: "Secrets",
  passAgentsCredentials: "Agent sign-ins",
};
const ACCESS_KEYS = Object.keys(ACCESS_LABELS) as ReadonlyArray<keyof BoatCloudEnvironmentAccess>;

const MACHINE_STATE_LABELS: Record<BoatCloudMachine["state"], string> = {
  running: "Running",
  starting: "Starting",
  stopped: "Stopped",
  gone: "Saved copy",
};

function stepState(setup: BoatCloudSetup, index: number): StepState {
  if (setup.status === "ready") return "done";
  if (setup.step === null || setup.status === "idle") return "pending";
  const current = BOAT_CLOUD_SETUP_STEPS.indexOf(setup.step);
  if (index < current) return "done";
  if (index > current) return "pending";
  return setup.status === "failed" ? "failed" : "active";
}

function Separated(props: { readonly index: number; readonly children: React.ReactNode }) {
  return (
    <View className={cn(props.index > 0 && "border-t border-border-subtle")}>{props.children}</View>
  );
}

export function SettingsCloudRouteScreen() {
  const insets = useSafeAreaInsets();
  const holders = useAtomValue(boatCloudHoldersAtom);
  const outdated = useAtomValue(boatCloudOutdatedMachinesAtom);
  const missingKey = holders.filter((holder) => !holder.status.connected);
  const phone = useAtomValue(phoneBoatCloudAtom);
  const { environments } = useEnvironments();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const connect = useAtomCommand(serverEnvironment.connectBoatCloud, "Connect Boat");
  const disconnect = useAtomCommand(serverEnvironment.disconnectBoatCloud, "Disconnect Boat");
  const runSetup = useAtomCommand(serverEnvironment.runBoatCloudSetup, "Set up Boat cloud");
  const configureEnvironment = useAtomCommand(
    serverEnvironment.configureBoatCloudEnvironment,
    "Change the Boat environment",
  );
  const [environmentBusy, setEnvironmentBusy] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this phone's Boat key and VMs from Boat when the page opens
  useEffect(() => {
    void refreshPhoneBoatCloud();
  }, []);

  // A machine builds the snapshot with its own server and skills, so one speaks first.
  const machineHolder = holders.find((holder) => holder.status.connected) ?? null;
  const machineSetupReady = machineHolder?.status.setup.status === "ready";
  const phoneSetupReady = phone.setup.status === "ready";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the phone reads the snapshot a machine just built from Boat, so it can start VMs once that machine disconnects
  useEffect(() => {
    if (machineSetupReady && !phoneSetupReady) void refreshPhoneBoatCloud();
  }, [machineSetupReady, phoneSetupReady]);

  const status = machineHolder?.status ?? (phone.connected ? phone : null);
  const connected = status !== null;
  const setup = status?.setup ?? null;
  const machines = [
    ...new Map(
      [...phone.machines, ...holders.flatMap((holder) => holder.status.machines)].map((m) => [
        m.sandboxId,
        m,
      ]),
    ).values(),
  ];
  const labelOf = (environmentId: string) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;

  const submitKey = async (value: string) => {
    const key = value.trim();
    if (!key || busy) return;
    setBusy(true);
    setKeyError(null);
    // The phone keeps the key so it can start VMs alone; every machine gets it too.
    const phoneError = await connectPhoneBoatCloud(key);
    if (phoneError === null) {
      const results = await Promise.all(
        holders.map(async (holder) => ({
          environmentId: holder.environmentId,
          result: await connect({ environmentId: holder.environmentId, input: { apiKey: key } }),
        })),
      );
      setApiKey("");
      // One builder only, the same one the Set up button picks, so nothing races to save it.
      const builder = results.find(({ result }) => result._tag === "Success");
      if (builder === undefined) {
        if (appAtomRegistry.get(phoneBoatCloudAtom).setup.status === "idle") {
          void runPhoneBoatCloudSetup();
        }
      } else if (
        builder.result._tag === "Success" &&
        builder.result.value.setup.status === "idle"
      ) {
        void runSetup({
          environmentId: builder.environmentId,
          input: { repositories: boatCloudSnapshotRepositories() },
        });
      }
    } else {
      setKeyError(phoneError);
    }
    setBusy(false);
  };

  // The phone keeps the key, so it hands it to machines that connected later or missed it.
  const enableOthers = async () => {
    const key = await readPhoneBoatCloudKey();
    if (key === null) return;
    setBusy(true);
    await Promise.all(
      missingKey.map((holder) =>
        connect({ environmentId: holder.environmentId, input: { apiKey: key } }),
      ),
    );
    setBusy(false);
  };

  const disconnectAll = () => {
    void disconnectPhoneBoatCloud();
    for (const holder of holders) {
      void disconnect({ environmentId: holder.environmentId, input: {} });
    }
  };

  const selectedEnvironment = status?.environments.find(
    (environment) => environment.name === status.environment,
  );
  // The phone and every machine start their own VMs, so each keeps the same choice.
  const applyEnvironment = async (environmentId: string, access?: BoatCloudEnvironmentAccess) => {
    setEnvironmentBusy(true);
    const [phoneError] = await Promise.all([
      phone.connected ? configurePhoneBoatCloudEnvironment(environmentId, access) : null,
      ...holders
        .filter((holder) => holder.status.connected)
        .map((holder) =>
          configureEnvironment({
            environmentId: holder.environmentId,
            input: { environmentId, ...(access ? { access } : {}) },
          }),
        ),
    ]);
    if (phoneError) Dialog.alert("Could not change this phone's Boat environment", phoneError);
    setEnvironmentBusy(false);
  };

  const startSetup = () => {
    if (machineHolder) {
      void runSetup({
        environmentId: machineHolder.environmentId,
        input: { repositories: boatCloudSnapshotRepositories() },
      });
    } else {
      void runPhoneBoatCloudSetup();
    }
  };

  return (
    <SettingsScreen title="Cloud">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          title="Boat"
          footer={
            connected
              ? undefined
              : (keyError ?? `The key needs ${BOAT_CLOUD_REQUIRED_SCOPES.join(", ")}.`)
          }
        >
          {connected ? (
            <View>
              <ListRowLayout
                leading={<BoatIcon size={22} colorClassName="accent-icon" />}
                label={status.account ?? "Connected"}
                description="Connected"
              />
              <View className="px-4 pb-4">
                <Button label="Disconnect" tone="danger" size="compact" onPress={disconnectAll} />
              </View>
            </View>
          ) : (
            <View className="gap-3 p-4">
              <SecretTextInput
                accessibilityLabel="Boat API key"
                placeholder="Boat API key"
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
            </View>
          )}
        </SettingsSection>

        {connected && setup ? (
          <SettingsSection
            title="Setup"
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
                onPress={startSetup}
              />
            }
          >
            {BOAT_CLOUD_SETUP_STEPS.map((step, index) => {
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

        {connected ? (
          <SettingsSection
            title="Environment"
            footer={
              status.environmentsError ??
              "New VMs start on this environment and keep it. Running VMs keep theirs."
            }
          >
            {status.environments.map((environment, index) => (
              <ListChoiceRow
                key={environment.id}
                label={environment.isDefault ? `${environment.name} (default)` : environment.name}
                selected={environment.id === selectedEnvironment?.id}
                separated={index > 0}
                disabled={environmentBusy}
                onPress={() => {
                  if (environment.id !== selectedEnvironment?.id) {
                    void applyEnvironment(environment.id);
                  }
                }}
              />
            ))}
            {selectedEnvironment
              ? ACCESS_KEYS.map((key) => (
                  <Separated key={key} index={1}>
                    <SettingsSwitchRow
                      label={ACCESS_LABELS[key]}
                      value={selectedEnvironment[key]}
                      disabled={environmentBusy}
                      onValueChange={(value) =>
                        void applyEnvironment(selectedEnvironment.id, {
                          passGithub: selectedEnvironment.passGithub,
                          passSandboxCredentials: selectedEnvironment.passSandboxCredentials,
                          passSecrets: selectedEnvironment.passSecrets,
                          passAgentsCredentials: selectedEnvironment.passAgentsCredentials,
                          [key]: value,
                        })
                      }
                    />
                  </Separated>
                ))
              : null}
          </SettingsSection>
        ) : null}

        {connected ? (
          <SettingsSection title="Enabled on">
            <ListRowLayout
              label="This phone"
              detail={phone.connected ? "Enabled" : "Not enabled"}
            />
            {holders.map((holder) => (
              <Separated key={holder.environmentId} index={1}>
                <ListRowLayout
                  label={labelOf(holder.environmentId)}
                  detail={holder.status.connected ? "Enabled" : "Not enabled"}
                />
              </Separated>
            ))}
            {outdated.map((environmentId) => (
              <Separated key={environmentId} index={1}>
                <ListRowLayout label={labelOf(environmentId)} detail="Needs update" />
              </Separated>
            ))}
            {phone.connected && missingKey.length > 0 ? (
              <Separated index={1}>
                <View className="p-4">
                  <Button
                    label="Enable on the others"
                    size="compact"
                    disabled={busy}
                    onPress={() => void enableOthers()}
                  />
                </View>
              </Separated>
            ) : null}
          </SettingsSection>
        ) : null}

        {connected && machines.length > 0 ? (
          <SettingsSection title="VMs">
            {machines.map((machine, index) => (
              <Separated key={machine.sandboxId} index={index}>
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

        <BoxdCloudSettingsSections />
      </ScrollView>
    </SettingsScreen>
  );
}
