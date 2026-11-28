import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { msg } from "gt-react-native";
import { Platform } from "react-native";

import { brandTitleOffset, CompactBrandTitle } from "../../../components/CompactBrandTitle";
import { WorkspaceConnectionTitle } from "../../home/WorkspaceConnectionTitle";
import { m, type MessageResolver } from "../../../i18n/messages";

function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
  resolve: MessageResolver = m,
): NativeStackNavigationOptions {
  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: resolve(msg("Threads", { $context: "screen title, list of chat threads" })),
    unstable_headerLeftItems: undefined,
  };
}

export function getConnectionAwareBrandHeaderOptions(opts: {
  readonly headerWidth: number;
  readonly trailingItemCount?: number;
  readonly onOpenEnvironments: () => void;
  readonly fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"];
  readonly resolve?: MessageResolver;
}): NativeStackNavigationOptions {
  const maxWidth = Math.max(0, opts.headerWidth - 64 - 44 * (opts.trailingItemCount ?? 1));

  return {
    ...getCompactBrandHeaderOptions(opts.fallbackTitleStyle, opts.resolve),
    headerTitle: () => (
      <WorkspaceConnectionTitle
        brand={<CompactBrandTitle />}
        maxWidth={maxWidth}
        onPress={opts.onOpenEnvironments}
        statusOffset={brandTitleOffset()}
      />
    ),
  };
}
