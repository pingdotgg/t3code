import {
  pendingUserShellItems,
  type UserShellItem,
} from "@t3tools/client-runtime/state/user-shell-commands";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Image } from "expo-image";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { contextChipAccent, contextChipPresentation } from "../../lib/composerChipPresentation";
import { contextChipIconSource } from "../../lib/contextChipIconSource";
import { createNativeComposerTheme } from "../../lib/nativeComposerTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { useUserShellCommandActions } from "./userShellCommands";

const TERMINAL_CHIP = contextChipPresentation("terminal");

function shellResultSummary(item: UserShellItem): string {
  if (item.status === "running") return "Still running. Its output so far";
  if (item.userShell.stoppedByUser) return "Stopped. Its output";
  if (item.exitCode !== undefined) return `Exited with code ${item.exitCode}. Its output`;
  return "Its output";
}

/** Shell results the server sends with the next message; removing one dismisses it. */
export function ComposerPendingShellCommands(props: {
  readonly threadRef: ScopedThreadRef;
  readonly canDismiss: boolean;
}) {
  const structure = useQuietThreadStructure(props.threadRef);
  const actions = useUserShellCommandActions();
  const { themeVariables: theme } = useAppearancePreferences();
  const items = structure === null ? [] : pendingUserShellItems(structure.projection);
  if (items.length === 0) return null;
  const accent =
    contextChipAccent(TERMINAL_CHIP.accent, theme, createNativeComposerTheme(theme).text) ??
    theme["--color-foreground"];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      accessibilityLabel="Shell results for your next message"
      className="grow-0"
      contentContainerClassName="flex-row items-center gap-3 px-4 pb-2"
    >
      {items.map((item) => (
        <View key={item.id} className="max-w-[240px] flex-row items-center gap-1">
          <Image
            source={contextChipIconSource({ kind: "chip", name: "terminal" })}
            tintColor={accent}
            style={{ width: 14, height: 14 }}
          />
          <Text
            accessibilityLabel={`${item.input}. ${shellResultSummary(item)} goes with your next message.`}
            className="min-w-0 shrink font-t3-medium text-sm"
            style={{ color: accent }}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {item.input}
          </Text>
          {props.canDismiss ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Leave out ${item.input}`}
              hitSlop={8}
              onPress={() =>
                void actions.setDelivery(
                  {
                    environmentId: props.threadRef.environmentId,
                    threadId: item.threadId,
                    itemId: item.id,
                  },
                  "dismissed",
                )
              }
              className="active:opacity-70"
            >
              <SymbolView
                name="xmark.circle.fill"
                size={14}
                tintColorClassName="accent-icon-subtle"
              />
            </Pressable>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}
