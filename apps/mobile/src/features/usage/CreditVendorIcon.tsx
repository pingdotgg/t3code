import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";
import { USAGE_CREDIT_VENDOR_ICONS, usageCreditVendor } from "@t3tools/shared/usageCreditIcons";
import { View } from "react-native";
import { Path, Svg } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** Brand glyph for a credit balance card; unknown vendors get an initials badge. */
export function CreditVendorIcon({
  balance,
  size = 18,
}: {
  readonly balance: {
    readonly id: string;
    readonly label: string;
    readonly icon?: string | undefined;
  };
  readonly size?: number;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const vendor = usageCreditVendor(balance);
  if (vendor) {
    const icon = USAGE_CREDIT_VENDOR_ICONS[vendor];
    const fill = themeAppearance === "dark" ? icon.fill.dark : icon.fill.light;
    return (
      <View style={{ opacity: 0.8 }}>
        <Svg width={size} height={size} viewBox={icon.viewBox} fill="none">
          {icon.paths.map((path) => (
            <Path key={path.d} d={path.d} fillRule={path.fillRule} fill={fill} />
          ))}
        </Svg>
      </View>
    );
  }
  return (
    <View
      className="items-center justify-center rounded-full bg-card"
      style={{ width: size, height: size }}
    >
      <Text
        className="text-foreground-muted"
        style={{ fontSize: Math.round(size * 0.45), fontWeight: "600", lineHeight: size }}
      >
        {providerInstanceInitials(balance.label)}
      </Text>
    </View>
  );
}
