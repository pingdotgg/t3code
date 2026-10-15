import { View } from "react-native";
import { Text } from "@expo/ui/jetpack-compose";
import { IconButton } from "../../components/IconButton";
import { NativeAppBar } from "../../components/NativeAppBar.android";

export function NativeAppBarExample() {
  return (
    <NativeAppBar
      title={<Text style={{ fontSize: 21 }}>Native app bar</Text>}
      navigationIcon={
        <IconButton icon="arrow.left" accessibilityLabel="Example back" onPress={() => {}} />
      }
      actions={
        <View className="flex-row">
          <IconButton
            icon="magnifyingglass"
            accessibilityLabel="Example search"
            onPress={() => {}}
          />
        </View>
      }
    />
  );
}
