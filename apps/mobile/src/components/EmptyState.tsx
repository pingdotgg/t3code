import { View } from "react-native";

import { AppText as Text } from "./AppText";
export function EmptyState(props: { readonly title: string; readonly detail: string }) {
  return (
    <View className="rounded-[22px] border border-slate-200 bg-white p-5 dark:border-white/6 dark:bg-slate-900">
      <Text className="font-t3-bold text-lg text-slate-950 dark:text-slate-50">{props.title}</Text>
      <Text className="mt-2 font-sans text-sm leading-[21px] text-slate-600 dark:text-slate-400">
        {props.detail}
      </Text>
    </View>
  );
}
