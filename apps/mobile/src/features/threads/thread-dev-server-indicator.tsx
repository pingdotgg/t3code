import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useCallback, useMemo } from "react";
import { Alert, Pressable } from "react-native";
import * as Option from "effect/Option";

import { SymbolView } from "../../components/AppSymbol";
import { devServerLabel, resolveDevServerUrl } from "../../lib/devServers";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useThreadDevServers } from "../../state/preview";
import { usePreparedConnection } from "../../state/session";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

// Matches the web sidebar's emerald globe. Theme variables carry no accent
// green, so the pair is inlined the way the row's PR label inlines its own.
const GLOBE_TINT_BY_APPEARANCE = {
  light: "#059669",
  dark: "#34d399",
} as const;

/**
 * The thread row's linked dev server glyph, mirroring the web sidebar globe.
 * Renders nothing until one of the thread's terminals owns a listening
 * server. Tapping opens the first reachable one.
 */
export const ThreadDevServerIndicator = memo(function ThreadDevServerIndicator(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const servers = useThreadDevServers({ environmentId, threadId });
  const preparedConnection = usePreparedConnection(environmentId);
  const { themeAppearance } = useAppearancePreferences();

  const resolved = useMemo(() => {
    const httpBaseUrl = Option.isSome(preparedConnection)
      ? preparedConnection.value.httpBaseUrl
      : null;
    return servers.map((server) => resolveDevServerUrl(httpBaseUrl, server));
  }, [preparedConnection, servers]);

  const target = useMemo(
    () => resolved.find((entry) => entry.reachable) ?? resolved[0] ?? null,
    [resolved],
  );

  const handlePress = useCallback(async () => {
    if (target === null) return;
    if (!target.reachable) {
      Alert.alert(
        "Dev server unreachable",
        "This dev server cannot be reached from this device over the current connection.",
      );
      return;
    }
    if (!(await tryOpenExternalUrl(target.url, "dev-server"))) {
      Alert.alert("Unable to open dev server", "The dev server URL could not be opened.");
    }
  }, [target]);

  if (target === null) {
    return null;
  }

  const extraCount = resolved.length - 1;
  return (
    <Pressable
      accessibilityLabel={
        extraCount > 0
          ? `Open ${devServerLabel(target.server)} (+${extraCount} more)`
          : `Open ${devServerLabel(target.server)}`
      }
      accessibilityRole="button"
      hitSlop={10}
      onPress={() => void handlePress()}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      <SymbolView
        name="globe"
        size={13}
        tintColor={GLOBE_TINT_BY_APPEARANCE[themeAppearance === "dark" ? "dark" : "light"]}
        type="monochrome"
      />
    </Pressable>
  );
});
