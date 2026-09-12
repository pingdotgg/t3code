/** @jsxImportSource react */
import {
  Hyperlink as SigilHyperlink,
  Text as SigilText,
} from "@alchemy.run/sigil";
import type { ComponentProps } from "react";
import { theme } from "../../../Util/Theme.ts";
import { useCliEnvironment } from "./Environment.tsx";

export type TextTone =
  | "default"
  | "muted"
  | "emphasis"
  | "brand"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "danger";

export interface TextProps extends Omit<
  ComponentProps<typeof SigilText>,
  "color"
> {
  readonly tone?: TextTone;
  readonly color?: ComponentProps<typeof SigilText>["color"];
}

/** CliKit typography primitive. Consumers never import Sigil directly. */
export function Text({
  tone = "default",
  color,
  backgroundColor,
  bold,
  dimColor,
  italic,
  underline,
  strikethrough,
  inverse,
  ...props
}: TextProps) {
  const { colors } = useCliEnvironment();
  return (
    <SigilText
      {...props}
      color={
        colors
          ? (color ??
            (tone === "default" || tone === "muted"
              ? undefined
              : theme.color[tone]))
          : undefined
      }
      backgroundColor={colors ? backgroundColor : undefined}
      bold={colors ? bold : undefined}
      dimColor={colors ? (dimColor ?? tone === "muted") : undefined}
      italic={colors ? italic : undefined}
      underline={colors ? underline : undefined}
      strikethrough={colors ? strikethrough : undefined}
      inverse={colors ? inverse : undefined}
    />
  );
}

type LinkProps = {
  readonly href: string;
  readonly children?: string;
};

export function Link({ href, children }: LinkProps) {
  const { colors } = useCliEnvironment();
  const label = children ?? href;
  return (
    <SigilHyperlink
      url={href}
      fallback={label !== href}
      color={colors ? theme.color.info : undefined}
      underline={colors || undefined}
    >
      {label}
    </SigilHyperlink>
  );
}
