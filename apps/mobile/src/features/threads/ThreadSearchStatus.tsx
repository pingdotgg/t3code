import { useNavigation } from "@react-navigation/native";
import {
  threadSearchSourceMessage,
  THREAD_SEARCH_LIMIT,
  type ThreadSearchSource,
} from "@t3tools/client-runtime/state/thread-search";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

export function ThreadSearchStatus(props: {
  readonly sources: ReadonlyArray<ThreadSearchSource>;
  readonly retry: () => void;
  readonly onOpenConnections?: () => void;
}) {
  const navigation = useNavigation();
  if (props.sources.length === 0) return null;
  const openConnections =
    props.onOpenConnections ??
    (() =>
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsEnvironments" },
      }));
  return (
    <View className="px-4 py-2">
      <Text className="text-xs text-foreground-muted">
        Message search: unarchived threads, up to {THREAD_SEARCH_LIMIT} matches per environment.
      </Text>
      <View accessibilityLiveRegion="polite">
        {props.sources.map((source) => {
          const message = threadSearchSourceMessage(source);
          return message === null ? null : (
            <Text key={source.environmentId} className="text-xs text-foreground-muted">
              {message}
            </Text>
          );
        })}
      </View>
      {props.sources.some((source) => source.status === "failed") ? (
        <Pressable
          accessibilityRole="button"
          onPress={props.retry}
          className="min-h-11 justify-center"
        >
          <Text>Retry message search</Text>
        </Pressable>
      ) : null}
      {props.sources.some(
        (source) => source.status === "disconnected" || source.status === "unsupported",
      ) ? (
        <Pressable
          accessibilityRole="button"
          onPress={openConnections}
          className="min-h-11 justify-center"
        >
          <Text>Manage environments</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
