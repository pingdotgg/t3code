import { useGT } from "gt-react-native";

import { AppBar } from "../../components/ui/AppBar";
import { SheetHeader } from "../../components/ui/SheetHeader";

/** A thread shown outside its route: in the inspector pane, or presented full screen with a close. */
export type ThreadInspectorPresentation =
  | { readonly onMaximize: () => void }
  | { readonly onClose: () => void };

export function ThreadInspectorHeader(
  props: ThreadInspectorPresentation & { readonly title: string; readonly subtitle?: string },
) {
  const gt = useGT();
  if ("onMaximize" in props) {
    return (
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        actions={[
          {
            accessibilityLabel: gt("Maximize thread"),
            icon: "arrow.up.left.and.arrow.down.right",
            onPress: props.onMaximize,
          },
        ]}
      />
    );
  }
  return (
    <SheetHeader
      title={props.title}
      subtitle={props.subtitle}
      onClose={props.onClose}
      accessibilityLabel={gt("Close thread")}
    />
  );
}
