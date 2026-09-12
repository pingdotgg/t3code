/** @jsxImportSource react */
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { useGlyphs } from "./Environment.tsx";
import { SpinnerGlyph } from "./Feedback.tsx";
import { ProgressBar } from "./ProgressBar.tsx";
import { Box, Row, Stack } from "./Layout.tsx";
import { Text } from "./Typography.tsx";
import { theme } from "../../../Util/Theme.ts";

export interface TaskRowProps {
  /** Status glyph. Ignored while `spinning`; defaults to the bullet glyph. */
  readonly icon?: string;
  /** Color for the glyph (and the spinner while `spinning`). */
  readonly iconColor?: string;
  /** Render an animated spinner frame in the glyph slot. */
  readonly spinning?: boolean;
  readonly label: ReactNode;
  /** Muted annotation directly after the label. */
  readonly detail?: ReactNode;
  /** Indentation in 2-space units. */
  readonly depth?: number;
  /** Extra trailing cells (status labels, chips). */
  readonly children?: ReactNode;
}

/**
 * The one status row shape shared by TaskTree and the plan/apply views:
 * glyph-or-spinner, bold label, muted detail, then any trailing cells.
 */
export function TaskRow({
  icon,
  iconColor,
  spinning = false,
  label,
  detail,
  depth = 0,
  children,
}: TaskRowProps) {
  const glyphs = useGlyphs();
  return (
    <Row gap={1} paddingLeft={depth * theme.space.indent}>
      {spinning ? (
        <SpinnerGlyph color={iconColor} />
      ) : (
        <Text color={iconColor}>{icon ?? glyphs.bullet}</Text>
      )}
      <Text bold={depth === 0}>{label}</Text>
      {detail === undefined ? null : <Text tone="muted">· {detail}</Text>}
      {children}
    </Row>
  );
}

export interface ProgressGroupRow {
  readonly id: string;
  readonly label: ReactNode;
  readonly completed: number;
  readonly total: number;
  readonly failed?: number;
  readonly detail?: ReactNode;
}

type ProgressGroupProps = {
  readonly rows: ReadonlyArray<ProgressGroupRow>;
  readonly width?: number;
  /** Fixed label column (truncated) so the count cells align across rows. */
  readonly labelWidth?: number;
};

export function ProgressGroup({
  rows,
  width = 20,
  labelWidth,
}: ProgressGroupProps) {
  return (
    <Stack>
      {rows.map((row) => {
        const complete = row.total > 0 && row.completed >= row.total;
        const variant = row.failed ? "error" : complete ? "success" : "info";
        return (
          <Row key={row.id}>
            <ProgressBar
              value={row.total <= 0 ? 0 : row.completed / row.total}
              width={width}
              showPercent={false}
              variant={variant}
            />
            {labelWidth === undefined ? (
              <Text>{row.label}</Text>
            ) : (
              <Box width={labelWidth} flexShrink={0}>
                <Text wrap="truncate-end">{row.label}</Text>
              </Box>
            )}
            <Text bold tone={variant === "error" ? "danger" : variant}>
              {row.completed}/{row.total}
            </Text>
            {row.failed ? (
              <Text tone="danger">({row.failed} failed)</Text>
            ) : null}
            {row.detail === undefined ? null : (
              <Text tone="muted">{row.detail}</Text>
            )}
          </Row>
        );
      })}
    </Stack>
  );
}

export class LiveStore<Value> {
  private value: Value;
  private readonly listeners = new Set<() => void>();
  constructor(initial: Value) {
    this.value = initial;
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = () => this.value;
  readonly set = (value: Value) => {
    this.value = value;
    for (const listener of this.listeners) listener();
  };
  readonly update = (f: (value: Value) => Value) => this.set(f(this.value));
}

export const useLiveStore = <Value,>(store: LiveStore<Value>): Value =>
  useSyncExternalStore(store.subscribe, store.snapshot);
