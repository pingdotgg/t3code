import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { crashReportingAvailable, setCrashReportsEnabled } from "../observability/observe";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  formatStartupCrashReport,
  parseStartupCrashRecords,
  type StartupCrashRecord,
} from "./crash-log-model";

// expo-updates retains only seven days of logs.
const LOG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type CrashLogState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly records: ReadonlyArray<StartupCrashRecord> };

// Not kept alive: each visit to the screen re-reads the log.
const crashLogAtom = Atom.make(
  Effect.tryPromise(() => Updates.readLogEntriesAsync(LOG_WINDOW_MS)).pipe(
    Effect.map((entries): CrashLogState => ({
      status: "ready",
      records: parseStartupCrashRecords(entries),
    })),
    Effect.catch((error) =>
      Effect.sync((): CrashLogState => {
        console.warn("[diagnostics] could not read the expo-updates log", error);
        return { status: "unavailable" };
      }),
    ),
  ),
).pipe(Atom.withLabel("mobile:diagnostics-crash-log"));

const UNAVAILABLE_CRASH_LOG_ATOM = Atom.make(
  AsyncResult.success<CrashLogState>({ status: "unavailable" }),
);

function useCrashLogState(): CrashLogState {
  const result = useAtomValue(Updates.isEnabled ? crashLogAtom : UNAVAILABLE_CRASH_LOG_ATOM);
  return AsyncResult.isSuccess(result) ? result.value : { status: "loading" };
}

function appIdentity() {
  return {
    version: Constants.expoConfig?.version ?? "0.0.0",
    // EAS assigns build numbers remotely, so expo-constants never sees them;
    // only the installed binary knows its own.
    build: Application.nativeBuildVersion ?? "dev",
  };
}

export function SettingsDiagnosticsRouteScreen() {
  const insets = useSafeAreaInsets();
  const state = useCrashLogState();
  const [copied, setCopied] = useState(false);

  const records = state.status === "ready" ? state.records : [];
  const copyReport = async () => {
    const ok = await tryCopyTextWithHaptic(formatStartupCrashReport(records, appIdentity()), {
      target: "crash report",
    });
    if (ok) setCopied(true);
  };

  return (
    <SettingsScreen title="Diagnostics">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-[18px]"
      >
        {crashReportingAvailable ? <CrashReportsSetting /> : null}

        <SettingsSection title="Startup crashes">
          {state.status === "loading" ? (
            <View className="items-center gap-3 px-6 py-8">
              <AppActivityIndicator />
              <Text className="text-center text-sm text-foreground-muted">Reading crash log…</Text>
            </View>
          ) : state.status === "unavailable" ? (
            <EmptyState
              icon="exclamationmark.triangle"
              title="Crash log unavailable"
              detail="Startup crash records are only kept in store and TestFlight builds."
            />
          ) : records.length === 0 ? (
            <EmptyState
              icon="checkmark.circle"
              title="No startup crashes"
              detail="Nothing has taken the app down during launch in the last 7 days."
            />
          ) : (
            records.map((record, index) => (
              <CrashRow key={record.timestamp} record={record} first={index === 0} />
            ))
          )}
        </SettingsSection>

        <View className="gap-3">
          <SettingsSection title="Actions">
            <SettingsActionRow
              icon={copied ? "checkmark" : "doc.on.doc"}
              label={copied ? "Copied" : "Copy crash report"}
              disabled={state.status !== "ready"}
              onPress={() => void copyReport()}
            />
          </SettingsSection>
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Paste the report into a GitHub issue. It contains the app version, the JavaScript error
            message, and the component stack. Error messages can quote values from the app, so read
            it over before sharing.
          </Text>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function CrashReportsSetting() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promiseExit" });
  // One change at a time, so a slow save never turns sending back on after a later opt-out.
  const [saving, setSaving] = useState(false);
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const enabled = AsyncResult.isSuccess(preferences)
    ? preferences.value.crashReportsEnabled !== false
    : true;

  const change = (value: boolean) => {
    setSaving(true);
    // Sending stops before the save and starts only after it.
    if (!value) void setCrashReportsEnabled(false);
    savePreferences({ crashReportsEnabled: value })
      .then((exit) => {
        if (Exit.isFailure(exit)) {
          console.warn("[diagnostics] could not save the crash report setting", exit.cause);
          return value ? undefined : setCrashReportsEnabled(true);
        }
        return value ? setCrashReportsEnabled(true) : undefined;
      })
      .catch((error: unknown) => {
        console.warn("[diagnostics] could not apply the crash report setting", error);
      })
      .finally(() => setSaving(false));
  };

  return (
    <View className="gap-3">
      <SettingsSection title="Crash reports">
        <SettingsSwitchRow
          icon="tray.and.arrow.up"
          label="Send crash reports"
          disabled={!ready || saving}
          value={enabled}
          onValueChange={change}
        />
      </SettingsSection>
      <Text className="px-2 text-sm leading-normal text-foreground-muted">
        When the app crashes or hits an error, it sends the error message, the stack trace, the app
        version, and the device model and OS version to the T3 Code team. Each launch also sends
        startup timings. Reports carry a random ID for this install.
      </Text>
    </View>
  );
}

function EmptyState(props: {
  readonly icon: "exclamationmark.triangle" | "checkmark.circle";
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <View className="items-center gap-2 px-6 py-8">
      <SymbolView
        name={props.icon}
        size={28}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="text-center text-base text-foreground">{props.title}</Text>
      <Text className="text-center text-sm text-foreground-muted">{props.detail}</Text>
    </View>
  );
}

function CrashRow(props: { readonly record: StartupCrashRecord; readonly first: boolean }) {
  const { record } = props;
  return (
    <View className={props.first ? "gap-1.5 p-4" : "gap-1.5 border-t border-border-subtle p-4"}>
      <Text className="text-xs text-foreground-muted">
        {new Date(record.timestamp).toLocaleString()}
      </Text>
      <Text selectable className="text-base leading-snug text-danger-foreground">
        {record.description}
      </Text>
      {record.frames.length > 0 ? (
        <Text selectable className="font-mono text-xs leading-snug text-foreground-muted">
          {record.frames.slice(0, 4).join("\n")}
        </Text>
      ) : null}
    </View>
  );
}
