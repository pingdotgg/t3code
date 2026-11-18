import { useNavigation } from "@react-navigation/native";

import { useOpenThreadInspector } from "../threads/thread-inspector-navigation";

/** Opens an environment's localhost page on this device: in the inspector pane where there is one. */
export function useOpenLocalPreview() {
  const navigation = useNavigation();
  const openInspector = useOpenThreadInspector();
  return (source: { readonly environmentId: string; readonly threadId: string }, url: string) => {
    if (openInspector(source, { type: "localPreview", ...source, url })) return;
    navigation.navigate("ThreadLocalPreview", { environmentId: source.environmentId, url });
  };
}
