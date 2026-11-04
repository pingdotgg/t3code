import { useAtomValue } from "@effect/atom-react";
import { formatConnectionLog } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { environmentCatalog } from "../../connection/catalog";
import { SettingsSection } from "./components/SettingsSection";

const SHOWN_EVENTS = 10;

/** The last connection attempts on this device, so a failure explains itself when shared. */
export function ConnectionLogSection(props: { readonly environmentId: EnvironmentId }) {
  const log = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.connectionLogAtom(props.environmentId)),
    () => [],
  );
  if (log.length === 0) return null;
  return (
    <SettingsSection title="Connection log">
      <View className="p-4">
        <Text selectable className="font-mono text-xs text-foreground-muted">
          {formatConnectionLog(log.slice(-SHOWN_EVENTS).reverse())}
        </Text>
      </View>
      <ListActionRow
        icon="doc.on.doc"
        label="Copy connection log"
        description={`${log.length} recent events`}
        onPress={() => {
          void Clipboard.setStringAsync(formatConnectionLog(log)).catch(() => undefined);
        }}
      />
    </SettingsSection>
  );
}
