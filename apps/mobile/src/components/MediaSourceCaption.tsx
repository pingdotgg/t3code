import { ScrollView } from "react-native";

import { AppText } from "./ui/AppText";
import { defineNativePluginFeature } from "../plugins/features";

export const MediaSourceCaption = defineNativePluginFeature(
  "native.components.media-source-caption",
  BuiltinMediaSourceCaption,
);

function BuiltinMediaSourceCaption(props: { readonly source: string | undefined }) {
  if (!props.source) return null;
  return (
    <ScrollView
      style={{ maxHeight: 88, flexGrow: 0 }}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8 }}
      nestedScrollEnabled
    >
      <AppText selectable className="text-xs text-white/70">
        {props.source}
      </AppText>
    </ScrollView>
  );
}
