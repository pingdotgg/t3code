import type { ReactNode } from "react";

import { Text } from "~/components/ui/text";

/**
 * The top of a pane's blank state: an icon disc, a title, one line of
 * explanation and what to do next. `strong` keeps a dialog title's weight and
 * contrast for content that moved into a pane.
 */
export function PreviewEmptyHero(props: {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly strong?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-4 py-6 text-center">
      <span
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-full surface-raised [&_svg]:size-4.5 [&_svg]:text-muted-foreground"
      >
        {props.icon}
      </span>
      <Text
        variant="label"
        tone={props.strong ? "strong" : "default"}
        emphasis={props.strong}
        render={<h2 />}
      >
        {props.title}
      </Text>
      <p className="max-w-[300px] text-balance text-body text-muted-foreground">
        {props.description}
      </p>
      {props.children ? <div className="pt-1.5">{props.children}</div> : null}
    </div>
  );
}
