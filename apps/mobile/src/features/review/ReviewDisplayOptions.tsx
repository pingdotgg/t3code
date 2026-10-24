import { Modal, Pressable, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

export interface ReviewDisplayOption {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}

/** The native counterpart of desktop's compact switch-based diff options. */
export function ReviewDisplayOptions({
  open,
  onClose,
  options,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly options: ReadonlyArray<ReviewDisplayOption>;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1" style={{ paddingTop: insets.top + 52, paddingHorizontal: 12 }}>
        <Pressable
          className="absolute inset-0"
          accessibilityRole="button"
          accessibilityLabel="Close view options"
          onPress={onClose}
        />
        <View className="w-full max-w-[320px] self-end overflow-hidden rounded-2xl border border-border-subtle bg-card shadow-lg">
          <View className="flex-row items-center border-b border-border-subtle px-3">
            <Text className="flex-1 text-sm font-t3-semibold">View options</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close view options"
              onPress={onClose}
              className="min-h-11 min-w-11 items-center justify-center"
            >
              <SymbolView name="xmark" size={15} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </View>
          <ScrollView
            style={{ maxHeight: 360 }}
            contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 4 }}
          >
            {options.map((option) => (
              <View key={option.id} className="min-h-11 flex-row items-center gap-2">
                <Pressable
                  className="min-h-11 min-w-0 flex-1 justify-center"
                  accessibilityRole="switch"
                  accessibilityLabel={option.label}
                  accessibilityState={{ checked: option.checked, disabled: option.disabled }}
                  disabled={option.disabled}
                  onPress={() => option.onChange(!option.checked)}
                >
                  <Text className={option.disabled ? "text-xs text-foreground-muted" : "text-xs"}>
                    {option.label}
                  </Text>
                </Pressable>
                <Switch
                  accessibilityLabel={option.label}
                  value={option.checked}
                  disabled={option.disabled}
                  onValueChange={option.onChange}
                />
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
