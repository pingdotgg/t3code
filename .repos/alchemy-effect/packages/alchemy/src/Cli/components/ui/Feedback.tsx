/** @jsxImportSource react */
import { useAnimation } from "@alchemy.run/sigil";
import type { ReactNode } from "react";
import stringWidth from "string-width";
import {
  spinnerFramesFor,
  statusColor,
  theme,
  type StatusVariant,
} from "../../../Util/Theme.ts";
import {
  useBorderStyle,
  useCliEnvironment,
  useGlyphs,
} from "./Environment.tsx";
import { Box, tabsWindow } from "./Layout.tsx";
import { Text } from "./Typography.tsx";

export interface StatusProps {
  readonly variant?: StatusVariant;
  readonly children?: ReactNode;
  readonly detail?: ReactNode;
}

export function Status({ variant = "info", children, detail }: StatusProps) {
  const glyphs = useGlyphs();
  return (
    <Box gap={1} flexWrap="wrap">
      <Text color={statusColor(variant)}>{glyphs[variant]}</Text>
      <Text color={variant === "error" ? statusColor(variant) : undefined}>
        {children}
      </Text>
      {detail === undefined ? null : <Text tone="muted">· {detail}</Text>}
    </Box>
  );
}

export type ToastProps = StatusProps;

/**
 * Compact application notice. Severity is carried by the status glyph and
 * its colour alone — the same vocabulary as transcript lines — so a notice
 * row never needs a rail of its own.
 */
export function Toast({ variant = "info", children, detail }: ToastProps) {
  return (
    <Status variant={variant} detail={detail}>
      {children}
    </Status>
  );
}

export interface AlertProps extends StatusProps {
  readonly title?: ReactNode;
}

/** Glyph + bold title on one row, body indented beneath it. */
export function Alert({
  variant = "info",
  title,
  children,
  detail,
}: AlertProps) {
  const glyphs = useGlyphs();
  return (
    <Box flexDirection="column">
      <Box gap={1} alignItems="center">
        <Text bold color={statusColor(variant)}>
          {glyphs[variant]}
        </Text>
        {title === undefined ? null : <Text bold>{title}</Text>}
        {detail === undefined ? null : <Text tone="muted">· {detail}</Text>}
      </Box>
      <Box paddingLeft={theme.space.indent}>
        <Text tone="muted">{children}</Text>
      </Box>
    </Box>
  );
}

export interface KeyBarProps {
  readonly keys: ReadonlyArray<readonly [key: string, label: string]>;
  readonly marginTop?: number;
  readonly inline?: boolean;
  /** Widget rendered before the key hints. */
  readonly before?: ReactNode;
  /** Widget rendered after the key hints. */
  readonly after?: ReactNode;
  /** Draw border rails between populated widget/key sections. */
  readonly divider?: boolean;
}

export function KeyBar({
  keys,
  marginTop = 1,
  inline = false,
  before,
  after,
  divider = false,
}: KeyBarProps) {
  const borderStyle = useBorderStyle();
  const sectionBorder = {
    borderStyle,
    borderLeft: true,
    borderRight: false,
    borderTop: false,
    borderBottom: false,
    borderColor: theme.color.muted,
    borderDimColor: true,
    marginLeft: 1,
    paddingLeft: 1,
  } as const;
  return (
    <Box
      width={inline ? undefined : "100%"}
      flexWrap="wrap"
      marginTop={marginTop}
      paddingLeft={before === undefined ? theme.space.indent : 0}
    >
      {before === undefined ? null : <Box>{before}</Box>}
      <Box
        flexWrap="wrap"
        {...(divider && before !== undefined
          ? sectionBorder
          : before === undefined
            ? {}
            : { marginLeft: 1 })}
      >
        {keys.map(([key, label], index) => (
          <Box key={`${key}:${label}`}>
            {index === 0 ? null : <Text tone="muted"> • </Text>}
            <Text>
              <Text bold color={theme.color.brand}>
                {key}
              </Text>
              <Text tone="muted"> {label}</Text>
            </Text>
          </Box>
        ))}
      </Box>
      {after === undefined ? null : (
        <Box
          {...(divider
            ? sectionBorder
            : {
                marginLeft: 1,
              })}
        >
          {after}
        </Box>
      )}
    </Box>
  );
}

export const useSpinnerFrame = (): string => {
  const { unicode } = useCliEnvironment();
  const frames = spinnerFramesFor(unicode);
  const { frame } = useAnimation({ interval: 80 });
  return frames[frame % frames.length] ?? "-";
};

/**
 * Spinner-as-status-icon: one animated frame, colorable so it can stand in
 * for a status glyph in trees and progress rows.
 */
type SpinnerGlyphProps = { readonly color?: string };

export function SpinnerGlyph({ color }: SpinnerGlyphProps) {
  return <Text color={color ?? theme.color.info}>{useSpinnerFrame()}</Text>;
}

type SpinnerProps = {
  readonly label: ReactNode;
  readonly detail?: ReactNode;
};

export function Spinner({ label, detail }: SpinnerProps) {
  return (
    <Box gap={1}>
      <SpinnerGlyph />
      <Text>{label}</Text>
      {detail === undefined ? null : <Text tone="muted">{detail}</Text>}
    </Box>
  );
}

type TabsProps = {
  readonly tabs: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly marked?: boolean;
  }>;
  readonly active: string;
};

export function Tabs({ tabs, active }: TabsProps) {
  const glyphs = useGlyphs();
  const { columns } = useCliEnvironment();
  const gap = 1;
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === active),
  );
  // chip width = paddingX (2) + optional marker glyph + space + label
  const widths = tabs.map(
    (tab) =>
      2 +
      stringWidth(tab.label) +
      (tab.marked ? stringWidth(glyphs.selected) + 1 : 0),
  );
  const totalWidth =
    widths.reduce((sum, width) => sum + width, 0) +
    Math.max(0, tabs.length - 1) * gap;
  const contentWidth = Math.max(1, columns - theme.space.indent);
  const { start, end } =
    totalWidth <= contentWidth
      ? { start: 0, end: tabs.length }
      : // reserve an arrow cell + gap on each side so the window stays put
        // whether or not the edge arrows render
        tabsWindow(
          widths,
          activeIndex,
          Math.max(1, contentWidth - 2 * (1 + gap)),
          gap,
        );
  return (
    <Box
      width="100%"
      gap={gap}
      paddingLeft={theme.space.indent}
      marginBottom={1}
      aria-role="tablist"
    >
      {start > 0 ? <Text tone="muted">{glyphs.overflowLeft}</Text> : null}
      {tabs.slice(start, end).map((tab) => {
        const selected = tab.id === active;
        return (
          <Box
            key={tab.id}
            paddingX={1}
            backgroundColor={selected ? theme.paint.interactive : undefined}
            aria-role="tab"
            aria-label={tab.label}
            aria-state={{ selected }}
          >
            <Text
              bold={selected}
              color={selected ? theme.color.onAccent : undefined}
              dimColor={!selected}
            >
              {tab.marked ? (
                <Text
                  color={selected ? theme.color.onAccent : theme.color.brand}
                >
                  {glyphs.selected}{" "}
                </Text>
              ) : null}
              {tab.label}
            </Text>
          </Box>
        );
      })}
      {end < tabs.length ? (
        <Text tone="muted">{glyphs.overflowRight}</Text>
      ) : null}
    </Box>
  );
}
