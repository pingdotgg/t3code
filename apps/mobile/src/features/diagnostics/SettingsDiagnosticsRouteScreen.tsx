import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  formatStartupCrashReport,
  parseStartupCrashRecords,
  type StartupCrashRecord,
} from "./crash-log-model";

// expo-updates keeps its persistent log this long. Reading any further back
// returns nothing, so this is the whole available window.
const LOG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type CrashLogState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly records: ReadonlyArray<StartupCrashRecord> };

function appIdentity() {
  return {
    version: Constants.expoConfig?.version ?? "0.0.0",
    build:
      (Platform.OS === "ios"
        ? Constants.platform?.ios?.buildNumber
        : Constants.platform?.android?.versionCode?.toString()) ?? "dev",
  };
}

/**
 * Startup crashes that TestFlight and the stores strip from their reports.
 * expo-updates' ErrorRecovery writes the JS error and component stack to its
 * own log before aborting the process, so the next launch can show it here.
 */
export function SettingsDiagnosticsRouteScreen() {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<CrashLogState>(() =>
    Updates.isEnabled ? { status: "loading" } : { status: "unavailable" },
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!Updates.isEnabled) return;
    let cancelled = false;
    Updates.readLogEntriesAsync(LOG_WINDOW_MS)
      .then((entries) => {
        if (cancelled) return;
        setState({ status: "ready", records: parseStartupCrashRecords(entries) });
      })
      .catch((error: unknown) => {
        console.warn("[diagnostics] could not read the expo-updates log", error);
        if (!cancelled) setState({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const records = state.status === "ready" ? state.records : [];
  const copyReport = async () => {
    const ok = await tryCopyTextWithHaptic(formatStartupCrashReport(records, appIdentity()), {
      target: "crash report",
    });
    if (ok) setCopied(true);
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-[18px]"
      >
        <SettingsSection title="Startup crashes">
          {state.status === "loading" ? (
            <View className="items-center gap-3 px-6 py-8">
              <ActivityIndicator />
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
            <Pressable
              accessibilityRole="button"
              disabled={state.status !== "ready"}
              onPress={() => void copyReport()}
              className="flex-row items-center gap-4 p-4 disabled:opacity-40"
            >
              <SymbolView
                name={copied ? "checkmark" : "doc.on.doc"}
                size={22}
                tintColorClassName={"accent-icon"}
                type="monochrome"
                weight="regular"
              />
              <Text className="flex-1 text-lg text-foreground">
                {copied ? "Copied" : "Copy crash report"}
              </Text>
            </Pressable>
          </SettingsSection>
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Paste the report into a GitHub issue. It contains the app version, the JavaScript error
            message, and the component stack. Error messages can quote values from the app, so read
            it over before sharing.
          </Text>
        </View>
      </ScrollView>
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
        tintColorClassName={"accent-icon"}
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
