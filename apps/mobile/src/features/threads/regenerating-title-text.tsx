import type { ComponentProps } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { useReduceMotionEnabled } from "../../lib/appState";
import { cn } from "../../lib/cn";
import { WorkShine } from "./work-shine";

type TextLayoutHandler = ComponentProps<typeof Text>["onTextLayout"];

/**
 * A thread title. While it is being regenerated, the live tool shine sweeps
 * across the old title (muted, with a bright band) until the new one arrives.
 * With reduce motion on it only dims, as it did before.
 */
export function RegeneratingTitleText(props: {
  readonly regenerating: boolean;
  readonly title: string;
  /** Font, size and layout classes, without a text colour. */
  readonly className?: string;
  /** Wraps the title while it shines; carries the title's flex sizing. */
  readonly containerClassName?: string;
  readonly colorClassName: string;
  /** The shining title's base colour. */
  readonly mutedColorClassName: string;
  /** The bright band's colour; defaults to `colorClassName`. */
  readonly shineColorClassName?: string;
  readonly numberOfLines: number;
  readonly onTextLayout?: TextLayoutHandler;
}) {
  const reducedMotion = useReduceMotionEnabled();
  if (!props.regenerating || reducedMotion) {
    return (
      <Text
        className={cn(
          props.containerClassName,
          props.className,
          props.colorClassName,
          props.regenerating && "opacity-55",
        )}
        numberOfLines={props.numberOfLines}
        onTextLayout={props.onTextLayout}
      >
        {props.title}
      </Text>
    );
  }
  return (
    <WorkShine className={props.containerClassName} shineInSidebar>
      {(layer) => (
        <Text
          className={cn(
            props.className,
            layer.highlighted
              ? (props.shineColorClassName ?? props.colorClassName)
              : props.mutedColorClassName,
          )}
          numberOfLines={props.numberOfLines}
          onTextLayout={
            layer.highlighted
              ? undefined
              : (event) => {
                  props.onTextLayout?.(event);
                  layer.onTextLayout(event);
                }
          }
        >
          {props.title}
        </Text>
      )}
    </WorkShine>
  );
}
