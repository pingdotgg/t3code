import type { BoatCloudSetup, BoatCloudSetupStep, BoxdCloudMachine } from "@t3tools/contracts";
import { CheckIcon, CircleDotIcon, CircleIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { boatCloudSnapshotRepositories } from "../../boatCloud";
import { usePrimaryBoxdCloudStatus } from "../../boxdCloud";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoxdIcon } from "../Icons";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { SecretInput } from "./SecretInput";
import { SettingsNote, SettingsRow, SettingsRowTile, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const SETUP_STEPS = ["create-vm", "install-server", "save-snapshot"] as const;

const STEP_LABELS: Record<(typeof SETUP_STEPS)[number], string> = {
  "create-vm": "Create a machine",
  "install-server": "Install T3 Code and clone repositories",
  "save-snapshot": "Save the T3 Code snapshot",
};

const MACHINE_STATE: Record<
  BoxdCloudMachine["state"],
  { readonly label: string; readonly variant: "success" | "info" | "unavailable" }
> = {
  running: { label: "Running", variant: "success" },
  asleep: { label: "Asleep", variant: "info" },
  stopped: { label: "Stopped", variant: "unavailable" },
};

type StepState = "done" | "active" | "failed" | "pending";

function stepState(setup: BoatCloudSetup, step: BoatCloudSetupStep): StepState {
  if (setup.status === "ready") return "done";
  if (setup.step === null || setup.status === "idle") return "pending";
  const current = SETUP_STEPS.findIndex((candidate) => candidate === setup.step);
  const index = SETUP_STEPS.findIndex((candidate) => candidate === step);
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

/** boxd cloud on the Cloud settings page. This machine holds the key and hands out machines. */
export function BoxdCloudSettingsSections() {
  const { holderEnvironmentId, status } = usePrimaryBoxdCloudStatus();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const connect = useAtomCommand(serverEnvironment.connectBoxdCloud, "Connect boxd");
  const disconnect = useAtomCommand(serverEnvironment.disconnectBoxdCloud, "Disconnect boxd");
  const runSetup = useAtomCommand(serverEnvironment.runBoxdCloudSetup, "Set up boxd cloud");
  if (holderEnvironmentId === null || status === null) return null;
  const setUp = () =>
    runSetup({
      environmentId: holderEnvironmentId,
      input: { repositories: boatCloudSnapshotRepositories() },
    });
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key || busy) return;
    setBusy(true);
    const result = await connect({ environmentId: holderEnvironmentId, input: { apiKey: key } });
    setBusy(false);
    if (result._tag !== "Success") return;
    setApiKey("");
    if (result.value.setup.status === "idle") void setUp();
  };
  const { connected, setup } = status;

  return (
    <>
      <SettingsSection
        {...searchableSetting("boxd-cloud")}
        title="boxd"
        icon={<BoxdIcon aria-hidden className="size-4" />}
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
              <BoxdIcon />
            </SettingsRowTile>
          }
          control={
            connected ? (
              <Button
                variant="destructive-outline"
                onClick={() => void disconnect({ environmentId: holderEnvironmentId, input: {} })}
              >
                Disconnect
              </Button>
            ) : (
              <form className="flex w-full min-w-0 gap-2 sm:w-80" onSubmit={onSubmit}>
                <SecretInput
                  aria-label="boxd API key"
                  placeholder="boxd API key"
                  value={apiKey}
                  disabled={busy}
                  maxLength={512}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <Button type="submit" disabled={busy || apiKey.trim() === ""}>
                  {busy ? "Connecting" : "Connect"}
                </Button>
              </form>
            )
          }
        />
        {connected ? null : (
          <SettingsNote>
            Create a key at{" "}
            <InlineButton
              tone="link"
              render={<a href="https://app.boxd.sh/keys" target="_blank" rel="noreferrer" />}
            >
              app.boxd.sh/keys
            </InlineButton>
            .
          </SettingsNote>
        )}
      </SettingsSection>

      {connected ? (
        <SettingsSection
          id="boxd-cloud-setup"
          title="boxd setup"
          headerAction={
            <Button
              variant="secondary"
              size="sm"
              disabled={setup.status === "running"}
              onClick={() => void setUp()}
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
          {SETUP_STEPS.map((step) => {
            const state = stepState(setup, step);
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

      {connected && status.machines.length > 0 ? (
        <SettingsSection id="boxd-cloud-machines" title="boxd machines">
          {status.machines.map((machine) => {
            const state = MACHINE_STATE[machine.state];
            return (
              <SettingsRow
                key={machine.vmId}
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
    </>
  );
}
