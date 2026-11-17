import {
  BOAT_CLOUD_REQUIRED_SCOPES,
  BOAT_CLOUD_SETUP_STEPS,
  type BoatCloudEnvironmentAccess,
  type BoatCloudMachine,
  type BoatCloudSetup,
  type BoatCloudSetupStep,
  type BoatCloudStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { CheckIcon, CircleDotIcon, CircleIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  boatCloudSnapshotRepositories,
  useBoatCloudKeyHolderStates,
  usePrimaryBoatCloudStatus,
} from "../../boatCloud";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoatIcon } from "../Icons";
import { BoxdCloudSettingsSections } from "./BoxdCloudSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { SecretInput } from "./SecretInput";
import {
  SettingsNote,
  SettingsPageContainer,
  SettingsRow,
  SettingsRowTile,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const STEP_LABELS: Record<BoatCloudSetupStep, string> = {
  "create-vm": "Create a VM",
  "install-server": "Install T3 Code and clone repositories",
  "copy-skills": "Copy this machine's skills",
  "save-snapshot": "Save the T3 Code snapshot",
};

const MACHINE_STATE: Record<
  BoatCloudMachine["state"],
  { readonly label: string; readonly variant: "success" | "info" | "unavailable" | "warning" }
> = {
  running: { label: "Running", variant: "success" },
  starting: { label: "Starting", variant: "info" },
  stopped: { label: "Stopped", variant: "unavailable" },
  gone: { label: "Saved copy", variant: "warning" },
};

const ACCESS_LABELS: Record<keyof BoatCloudEnvironmentAccess, string> = {
  passGithub: "GitHub access",
  passSandboxCredentials: "Boat credentials",
  passSecrets: "Secrets",
  passAgentsCredentials: "Agent sign-ins",
};
const ACCESS_KEYS = Object.keys(ACCESS_LABELS) as ReadonlyArray<keyof BoatCloudEnvironmentAccess>;

type StepState = "done" | "active" | "failed" | "pending";

function stepState(setup: BoatCloudSetup, index: number): StepState {
  if (setup.status === "ready") return "done";
  if (setup.step === null || setup.status === "idle") return "pending";
  const current = BOAT_CLOUD_SETUP_STEPS.indexOf(setup.step);
  if (index < current) return "done";
  if (index > current) return "pending";
  return setup.status === "failed" ? "failed" : "active";
}

// Static glyphs: setup takes minutes, and a spinner would repaint the whole time.
function StepIcon({ state }: { readonly state: StepState }) {
  if (state === "done") return <CheckIcon aria-hidden className="size-4 text-success-foreground" />;
  if (state === "failed") return <XIcon aria-hidden className="size-4 text-error-foreground" />;
  if (state === "active")
    return <CircleDotIcon aria-hidden className="size-4 text-info-foreground" />;
  return <CircleIcon aria-hidden className="size-4 text-dim-foreground" />;
}

/** Machines that hand out VMs: every connected one except the VMs themselves. */
function useKeyHolders(vmEnvironmentIds: ReadonlySet<EnvironmentId>) {
  const { environments } = useEnvironments();
  return environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      !environment.boatCloud &&
      !environment.boxdCloud &&
      !vmEnvironmentIds.has(environment.environmentId),
  );
}

function KeyHolderRow({
  environment,
  state,
}: {
  readonly environment: EnvironmentPresentation;
  readonly state: BoatCloudStatus | "unsupported" | null | undefined;
}) {
  return (
    <SettingsRow
      title={environment.label}
      control={
        state === "unsupported" ? (
          <Badge variant="warning">Needs update</Badge>
        ) : state?.connected ? (
          <Badge variant="success">Enabled</Badge>
        ) : (
          <Badge variant="unavailable">Not enabled</Badge>
        )
      }
    />
  );
}

function ApiKeyForm({
  holders,
  setupEnvironmentId,
}: {
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
  readonly setupEnvironmentId: EnvironmentId | null;
}) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const connect = useAtomCommand(serverEnvironment.connectBoatCloud, "Connect Boat");
  const runSetup = useAtomCommand(serverEnvironment.runBoatCloudSetup, "Set up Boat cloud");
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key || busy) return;
    setBusy(true);
    // Every machine gets the key, so a thread started on any of them can use Boat cloud.
    const results = await Promise.all(
      holders.map(async (holder) => ({
        environmentId: holder.environmentId,
        result: await connect({ environmentId: holder.environmentId, input: { apiKey: key } }),
      })),
    );
    setBusy(false);
    if (results.some(({ result }) => result._tag === "Success")) setApiKey("");
    // Only this machine builds the snapshot, so connected machines never race to save it.
    const own = results.find(({ environmentId }) => environmentId === setupEnvironmentId);
    if (own?.result._tag === "Success" && own.result.value.setup.status === "idle") {
      void runSetup({
        environmentId: own.environmentId,
        input: { repositories: boatCloudSnapshotRepositories() },
      });
    }
  };
  return (
    <form className="flex w-full min-w-0 gap-2 sm:w-80" onSubmit={onSubmit}>
      <SecretInput
        aria-label="Boat API key"
        placeholder="Boat API key"
        value={apiKey}
        disabled={busy}
        maxLength={512}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <Button type="submit" disabled={busy || apiKey.trim() === "" || holders.length === 0}>
        {busy ? "Connecting" : "Connect"}
      </Button>
    </form>
  );
}

/** The Boat environment new VMs start on, and what it passes to them. Every key holder gets the same choice. */
function EnvironmentSection({
  status,
  holders,
}: {
  readonly status: BoatCloudStatus;
  readonly holders: ReadonlyArray<EnvironmentPresentation>;
}) {
  const configure = useAtomCommand(
    serverEnvironment.configureBoatCloudEnvironment,
    "Change the Boat environment",
  );
  const [busy, setBusy] = useState(false);
  const selected = status.environments.find(
    (environment) => environment.name === status.environment,
  );
  const apply = async (environmentId: string, access?: BoatCloudEnvironmentAccess) => {
    setBusy(true);
    await Promise.all(
      holders.map((holder) =>
        configure({
          environmentId: holder.environmentId,
          input: { environmentId, ...(access ? { access } : {}) },
        }),
      ),
    );
    setBusy(false);
  };
  return (
    <SettingsSection id="boat-cloud-environment" title="Environment">
      {status.environmentsError !== null ? (
        <SettingsNote>{status.environmentsError}</SettingsNote>
      ) : (
        <>
          <SettingsRow
            title="Environment"
            control={
              <Select
                value={selected?.id ?? null}
                onValueChange={(value) => {
                  if (typeof value === "string" && value !== selected?.id) void apply(value);
                }}
              >
                <SelectTrigger
                  variant="well"
                  size="compact"
                  className="w-full sm:w-56"
                  aria-label="Boat environment"
                  disabled={busy}
                >
                  <SelectValue>{selected?.name ?? "Choose"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {status.environments.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      {environment.name}
                      {environment.isDefault ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {selected
            ? ACCESS_KEYS.map((key) => (
                <SettingsRow
                  key={key}
                  title={ACCESS_LABELS[key]}
                  control={
                    <Switch
                      aria-label={ACCESS_LABELS[key]}
                      checked={selected[key]}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        void apply(selected.id, {
                          passGithub: selected.passGithub,
                          passSandboxCredentials: selected.passSandboxCredentials,
                          passSecrets: selected.passSecrets,
                          passAgentsCredentials: selected.passAgentsCredentials,
                          [key]: Boolean(checked),
                        })
                      }
                    />
                  }
                />
              ))
            : null}
          <SettingsNote>
            New VMs start on this environment and keep it. Running VMs keep theirs.
          </SettingsNote>
        </>
      )}
    </SettingsSection>
  );
}

export function BoatCloudSettingsPanel() {
  const { holderEnvironmentId, status } = usePrimaryBoatCloudStatus();
  const vmEnvironmentIds = new Set(
    (status?.machines ?? []).flatMap((machine) =>
      machine.environmentId === null ? [] : [machine.environmentId],
    ),
  );
  const holderStates = useBoatCloudKeyHolderStates();
  const machines = useKeyHolders(vmEnvironmentIds);
  // A machine whose T3 Code predates Boat cloud cannot take the key until it updates.
  const holders = machines.filter((machine) => {
    const state = holderStates.get(machine.environmentId);
    return state !== undefined && state !== "unsupported";
  });
  const missingKey = holders.filter((holder) => {
    const state = holderStates.get(holder.environmentId);
    return state !== "unsupported" && state?.connected === false;
  });
  const runSetup = useAtomCommand(serverEnvironment.runBoatCloudSetup, "Set up Boat cloud");
  const disconnect = useAtomCommand(serverEnvironment.disconnectBoatCloud, "Disconnect Boat");
  const connected = status?.connected === true;
  const setup = status?.setup;

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("boat-cloud")}
        title="Boat"
        icon={<BoatIcon aria-hidden className="size-4" />}
      >
        <SettingsRow
          title={
            connected ? (
              <span className="wrap-anywhere">{status.account ?? "Connected"}</span>
            ) : (
              "API key"
            )
          }
          description={connected ? "Connected" : undefined}
          leading={
            <SettingsRowTile>
              <BoatIcon />
            </SettingsRowTile>
          }
          control={
            connected && holderEnvironmentId !== null ? (
              <Button
                variant="destructive-outline"
                onClick={() => {
                  for (const holder of holders) {
                    void disconnect({ environmentId: holder.environmentId, input: {} });
                  }
                }}
              >
                Disconnect
              </Button>
            ) : status ? (
              <ApiKeyForm holders={holders} setupEnvironmentId={holderEnvironmentId} />
            ) : null
          }
        />
        {status && !connected ? (
          <SettingsNote>
            The key needs{" "}
            {BOAT_CLOUD_REQUIRED_SCOPES.map((scope, index) => (
              <span key={scope}>
                <Text variant="caption" mono tone="muted">
                  {scope}
                </Text>
                {index < BOAT_CLOUD_REQUIRED_SCOPES.length - 1 ? ", " : "."}
              </span>
            ))}
          </SettingsNote>
        ) : null}
      </SettingsSection>

      {connected ? <EnvironmentSection status={status} holders={holders} /> : null}

      {connected && setup ? (
        <SettingsSection
          id="boat-cloud-setup"
          title="Setup"
          headerAction={
            <Button
              variant="secondary"
              size="sm"
              disabled={setup.status === "running"}
              onClick={() => {
                if (holderEnvironmentId === null) return;
                void runSetup({
                  environmentId: holderEnvironmentId,
                  input: { repositories: boatCloudSnapshotRepositories() },
                });
              }}
            >
              {setup.status === "running"
                ? "Setting up"
                : setup.status === "ready"
                  ? "Rebuild snapshot"
                  : setup.status === "failed"
                    ? "Retry"
                    : "Set up"}
            </Button>
          }
        >
          {BOAT_CLOUD_SETUP_STEPS.map((step, index) => {
            const state = stepState(setup, index);
            return (
              <SettingsRow
                key={step}
                title={STEP_LABELS[step]}
                leading={<StepIcon state={state} />}
                description={state === "failed" ? (setup.error ?? undefined) : undefined}
              />
            );
          })}
        </SettingsSection>
      ) : null}

      {connected ? (
        <SettingsSection id="boat-cloud-key-holders" title="Enabled on">
          {machines.map((machine) => (
            <KeyHolderRow
              key={machine.environmentId}
              environment={machine}
              state={holderStates.get(machine.environmentId)}
            />
          ))}
          {missingKey.length > 0 ? (
            <SettingsRow
              title="Enable on the others"
              control={<ApiKeyForm holders={missingKey} setupEnvironmentId={null} />}
            />
          ) : null}
        </SettingsSection>
      ) : null}

      {connected && status.machines.length > 0 ? (
        <SettingsSection id="boat-cloud-machines" title="VMs">
          {status.machines.map((machine) => {
            const state = MACHINE_STATE[machine.state];
            return (
              <SettingsRow
                key={machine.sandboxId}
                title={machine.label}
                description={
                  machine.repositories.length > 0
                    ? machine.repositories
                        .map((repository) => repository.split("/").slice(1).join("/"))
                        .join(", ")
                    : undefined
                }
                control={<Badge variant={state.variant}>{state.label}</Badge>}
              />
            );
          })}
        </SettingsSection>
      ) : null}

      <BoxdCloudSettingsSections />
    </SettingsPageContainer>
  );
}
