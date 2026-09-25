import { ActivityIndicator, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

export function FilePreviewLoading(props: {
  readonly message: string;
  readonly background?: "sheet" | "card";
}) {
  return (
    <View
      className={cn(
        "flex-1 items-center justify-center gap-3 px-6",
        props.background === "card" ? "bg-card" : "bg-sheet",
      )}
    >
      <ActivityIndicator />
      <Text className="text-center text-sm text-foreground-muted">{props.message}</Text>
    </View>
  );
}

export function FilePreviewNotice(props: { readonly title?: string; readonly children: string }) {
  return (
    <View className="border-b border-warning-border bg-warning px-4 py-2">
      {props.title ? (
        <Text className="text-2xs font-t3-bold uppercase text-warning-foreground">
          {props.title}
        </Text>
      ) : null}
      <Text className="text-xs leading-snug text-warning-foreground">{props.children}</Text>
    </View>
  );
}
