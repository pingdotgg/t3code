import { useGT } from "gt-react-native";
import type { ComponentProps, ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { type Kompas, useKompas } from "./state";

/** A page that needs a Kompas machine; says so while there is none. */
export function KompasPage(props: {
  readonly title: string;
  /** Shown as a tab rather than pushed over one. */
  readonly tab?: boolean;
  readonly actions?: ComponentProps<typeof SettingsScreen>["actions"];
  readonly children: (kompas: Kompas) => ReactNode;
}) {
  const gt = useGT();
  const kompas = useKompas();
  const insets = useSafeAreaInsets();
  const clearance = useWorkspaceTabs()?.bottomClearance ?? 0;
  return (
    <SettingsScreen title={props.title} actions={props.actions} workspaceRoot={props.tab}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom + 24, clearance) }}
      >
        {kompas === null ? (
          <EmptyState
            variant="plain"
            title={gt("No computer connected")}
            detail={gt("Connect your computer to see what it keeps here.")}
          />
        ) : (
          props.children(kompas)
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function Card(props: { readonly children: ReactNode; readonly highlighted?: boolean }) {
  return (
    <View
      className={
        props.highlighted
          ? "gap-2 rounded-3xl border border-primary/30 bg-primary/5 p-4"
          : "gap-2 rounded-3xl border border-border bg-card p-4"
      }
    >
      {props.children}
    </View>
  );
}

export function Bar(props: { readonly value: number; readonly label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, props.value)) * 100);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={props.label}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
      className="h-2 flex-1 overflow-hidden rounded-full bg-subtle-strong"
    >
      <View className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
    </View>
  );
}
