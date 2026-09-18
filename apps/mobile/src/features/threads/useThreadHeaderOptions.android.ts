import type { useThreadHeaderOptions as useIosThreadHeaderOptions } from "./useThreadHeaderOptions.ios";
import type { ThreadHeaderProps } from "./ThreadHeader.types";

export function useThreadHeaderOptions(
  props: ThreadHeaderProps,
): ReturnType<typeof useIosThreadHeaderOptions> {
  return {
    options: { contentStyle: { backgroundColor: props.headerColor } },
    sidebar: true,
    fallback: null,
  };
}
