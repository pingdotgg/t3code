import { ScrollView } from "react-native";

import { AppText } from "./AppText";

/** Keep the original reference readable without letting long URLs displace the preview. */
export function MediaSourceCaption(props: { readonly source: string | undefined }) {
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
