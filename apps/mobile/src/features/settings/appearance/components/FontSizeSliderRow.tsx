import type { ComponentProps } from "react";
import { SliderRow } from "../../../../components/SliderRow";

export function FontSizeSliderRow(
  props: Omit<ComponentProps<typeof SliderRow>, "minimumIcon" | "maximumIcon">,
) {
  return (
    <SliderRow
      {...props}
      minimumIcon="textformat.size.smaller"
      maximumIcon="textformat.size.larger"
    />
  );
}
