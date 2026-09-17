import type { ComponentProps } from "react";
import { MaterialFloatingActionButton } from "./MaterialFloatingActionButton.android";
import type { MaterialNewThreadButton as SharedMaterialNewThreadButton } from "./MaterialNewThreadButton.shared";

export function MaterialNewThreadButton(
  props: ComponentProps<typeof SharedMaterialNewThreadButton>,
) {
  return (
    <MaterialFloatingActionButton
      {...props}
      icon="square.and.pencil"
      label="New thread"
      tone="primary"
      variant={props.extended ? "extended" : "large"}
    />
  );
}
