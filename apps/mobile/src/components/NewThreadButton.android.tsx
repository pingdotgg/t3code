import { useGT } from "gt-react-native";
import type { ComponentProps } from "react";
import { FloatingActionButton } from "./ui/FloatingActionButton.android";
import { ScrollComposeButton } from "./ScrollComposeButton.android";
import type { NewThreadButton as SharedNewThreadButton } from "./NewThreadButton.shared";
import { defineNativePluginFeature } from "../plugins/features";

export const NewThreadButton = defineNativePluginFeature(
  "native.components.new-thread-button",
  BuiltinNewThreadButton,
);

function BuiltinNewThreadButton(props: ComponentProps<typeof SharedNewThreadButton>) {
  const gt = useGT();
  if (props.extended && props.expanded !== undefined) {
    return <ScrollComposeButton {...props} expanded={props.expanded} />;
  }
  return (
    <FloatingActionButton
      {...props}
      icon="square.and.pencil"
      label={gt("New thread")}
      tone="primary"
      variant={props.extended ? "extended" : "large"}
    />
  );
}
