import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

export type ThreadRecapTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
};

export function ThreadRecapSheet({ route }: StaticScreenProps<ThreadRecapTarget>) {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { data: recap } = useEnvironmentQuery(
    orchestrationEnvironment.v2.threadRecap({
      environmentId: route.params.environmentId,
      input: { threadId: route.params.threadId },
    }),
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader
        title={gt("Recap", { $context: "mobile sheet title: short live summary of the thread" })}
        onClose={() => navigation.goBack()}
      />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-3 px-5 pt-3 pb-6"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {recap?.text ? (
            <Text selectable className="text-base leading-6 text-foreground">
              {recap.text}
            </Text>
          ) : recap?.status === "pending" ? (
            <View className="flex-row items-center gap-3 py-4">
              <AppActivityIndicator size="small" />
              <Text className="text-sm text-foreground-muted">
                <T>Generating recap…</T>
              </Text>
            </View>
          ) : (
            <Text className="py-4 text-sm text-foreground-muted">
              <T>No recap yet. A short summary appears after turns settle.</T>
            </Text>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
