import type { ServerProvider } from "@t3tools/contracts";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";
import { providerNeedsSetup } from "./provider-setup-state";

export function ProviderSetupLink(props: {
  readonly provider: ServerProvider;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const label = props.provider.displayName ?? props.provider.driver;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-12 flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-40"
    >
      <ProviderIcon provider={props.provider.driver} size={18} />
      <Text className="min-w-0 flex-1 text-base text-foreground">
        {providerNeedsSetup(props.provider) ? `Set up ${label}` : `Manage ${label}`}
      </Text>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground" />
    </Pressable>
  );
}
