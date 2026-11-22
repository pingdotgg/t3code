import { useGT, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  type AccountSyncEnvironment,
  type ProviderAccountSyncReport,
  supportsProviderAccountSync,
} from "@t3tools/client-runtime/state/provider-account-sync";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { providerAccountSync, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  syncDestinationChoice,
  syncResultRow,
  type SyncResultRow,
} from "./providerAccountSync.logic";
import type { SettingsTarget } from "./settings-environment-filter";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

function useAccountSyncEnvironment(
  environment: EnvironmentPresentation,
  canManageProviders: boolean,
): AccountSyncEnvironment {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environment.environmentId));
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environment.environmentId)) ??
    EMPTY_PROVIDERS;
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    connection: environment.connection,
    serverConfig: environment.serverConfig,
    canManageProviders,
    settings,
    providers,
  };
}

function DestinationRow({
  source,
  destination,
  provider,
  checked,
  disabled,
  onChange,
}: {
  readonly source: AccountSyncEnvironment;
  readonly destination: EnvironmentPresentation;
  readonly provider: ServerProvider;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (environmentId: EnvironmentId, checked: boolean) => void;
}) {
  const messages = useMessages();
  const canImport = useAtomValue(providerAccountSync.canImportAtom(destination.environmentId));
  const destinationEnvironment = useAccountSyncEnvironment(destination, canImport);
  const choice = syncDestinationChoice(
    {
      source,
      destination: destinationEnvironment,
      instanceId: provider.instanceId,
    },
    messages,
  );
  return (
    <SettingsSwitchRow
      label={choice.label}
      subtitle={choice.note ?? undefined}
      disabled={choice.disabled || disabled}
      value={checked && !choice.disabled}
      onValueChange={(next) => onChange(choice.environmentId, next)}
    />
  );
}

function ResultRow({
  cell,
  accountLabel,
  source,
  destination,
}: {
  readonly cell: ProviderAccountSyncReport["cells"][number];
  readonly accountLabel: string;
  readonly source: EnvironmentPresentation;
  readonly destination: EnvironmentPresentation | undefined;
}) {
  const messages = useMessages();
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(cell.destinationEnvironmentId)) ??
    EMPTY_PROVIDERS;
  const row: SyncResultRow = syncResultRow(
    {
      cell,
      accountLabel,
      sourceLabel: source.label,
      destinationLabel: destination?.label ?? cell.destinationEnvironmentId,
      destinationProvider: providers.find((candidate) => candidate.instanceId === cell.instanceId),
    },
    messages,
  );
  return (
    <View className="gap-1 px-4 py-3">
      <Text textRole="body">{row.title}</Text>
      <Text
        textRole="footnote"
        accessibilityRole={row.tone === "danger" ? "alert" : undefined}
        className={row.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted"}
      >
        {row.description}
      </Text>
    </View>
  );
}

/**
 * Copies one provider account to other connected environments. Settings and API keys travel,
 * sign-ins do not; the destination's own account row finishes sign-in.
 */
export function ProviderAccountSync({
  environment,
  provider,
  accountLabel,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
  readonly accountLabel: string;
}) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const canExport = useAtomValue(providerAccountSync.canExportAtom(environment.environmentId));
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const others = environments.filter((entry) => entry.environmentId !== environment.environmentId);
  if (
    !canExport ||
    !supportsProviderAccountSync(environment) ||
    !others.some((entry) => entry.connection.phase === "connected")
  )
    return null;

  return (
    <>
      <SettingsActionRow
        icon="arrow.left.arrow.right"
        label={gt("Sync to…")}
        description={gt("Copy this account's settings to another device.")}
        disabled={running}
        onPress={() => setOpen((current) => !current)}
      />
      {open ? (
        <SyncPanel
          environment={environment}
          others={others}
          provider={provider}
          accountLabel={accountLabel}
          running={running}
          setRunning={setRunning}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

// Mounted only while open, so a closed row never subscribes to the environment's settings.
function SyncPanel({
  environment,
  others,
  provider,
  accountLabel,
  running,
  setRunning,
  onClose,
}: {
  readonly environment: SettingsTarget;
  readonly others: ReadonlyArray<EnvironmentPresentation>;
  readonly provider: ServerProvider;
  readonly accountLabel: string;
  readonly running: boolean;
  readonly setRunning: (running: boolean) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const source = useAccountSyncEnvironment(environment, true);
  const sync = useAtomCommand(providerAccountSync, { reportFailure: false });
  const [chosen, setChosen] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const [report, setReport] = useState<ProviderAccountSyncReport | null>(null);
  const runSync = async () => {
    setRunning(true);
    const result = await sync({
      sourceEnvironmentId: environment.environmentId,
      instanceIds: [provider.instanceId],
      destinationEnvironmentIds: [...chosen],
    });
    setRunning(false);
    // The command never fails as a whole; an interruption leaves the report as it was.
    if (result._tag === "Success") setReport(result.value);
  };

  return (
    <View>
      <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
        {report === null
          ? gt(
              "Settings and API keys are copied from {environment}. Sign-ins are not: each device signs in on its own. Paths stay on {environment}.",
              { environment: environment.label },
            )
          : gt("Sync again at any time; it updates the copies without duplicating them.")}
      </Text>
      {report === null ? (
        <>
          {others.map((destination) => (
            <DestinationRow
              key={destination.environmentId}
              source={source}
              destination={destination}
              provider={provider}
              checked={chosen.has(destination.environmentId)}
              disabled={running}
              onChange={(environmentId, checked) =>
                setChosen((current) => {
                  const next = new Set(current);
                  if (checked) next.add(environmentId);
                  else next.delete(environmentId);
                  return next;
                })
              }
            />
          ))}
          <SettingsActionRow
            icon="arrow.right"
            label={
              running ? gt("Syncing…") : gt("Sync", { $context: "verb, copy a provider account" })
            }
            disabled={chosen.size === 0}
            loading={running}
            onPress={() => void runSync()}
          />
          <SettingsActionRow
            icon="xmark"
            label={gt("Cancel")}
            disabled={running}
            onPress={onClose}
          />
        </>
      ) : (
        <>
          {report.cells.map((cell) => (
            <ResultRow
              key={`${cell.instanceId}:${cell.destinationEnvironmentId}`}
              cell={cell}
              accountLabel={accountLabel}
              source={environment}
              destination={others.find(
                (entry) => entry.environmentId === cell.destinationEnvironmentId,
              )}
            />
          ))}
          {report.cells.some((cell) => cell.status === "failed") ? (
            <SettingsActionRow
              icon="arrow.clockwise"
              label={gt("Retry")}
              loading={running}
              onPress={() => void runSync()}
            />
          ) : null}
          <SettingsActionRow icon="checkmark" label={gt("Done")} onPress={onClose} />
        </>
      )}
    </View>
  );
}
