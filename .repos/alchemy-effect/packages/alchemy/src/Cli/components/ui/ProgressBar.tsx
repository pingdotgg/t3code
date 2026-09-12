/** @jsxImportSource react */
import type { ReactNode } from "react";
import { statusPaint, type StatusVariant } from "../../../Util/Theme.ts";
import { useCliEnvironment } from "./Environment.tsx";
import { Box } from "./Layout.tsx";
import { Text } from "./Typography.tsx";

export interface ProgressBarProps {
  /** Completion ratio. Values outside 0..1 are clamped. */
  readonly value: number;
  /** Width in terminal cells (default: 24). */
  readonly width?: number;
  readonly showPercent?: boolean;
  readonly label?: ReactNode;
  readonly detail?: ReactNode;
  readonly variant?: StatusVariant;
}

/** Left-to-right progress using half/full Braille cells and an ASCII fallback. */
export function ProgressBar({
  value,
  width = 24,
  showPercent = true,
  label,
  detail,
  variant = "success",
}: ProgressBarProps) {
  const { unicode } = useCliEnvironment();
  const ratio = Math.max(0, Math.min(1, value));
  const cells = Math.max(1, Math.floor(width));
  const steps = Math.floor(cells * ratio * (unicode ? 2 : 1));
  const filled = unicode ? Math.floor(steps / 2) : steps;
  const partial = unicode && steps % 2 !== 0 ? "⡇" : "";
  const remaining = cells - filled - (partial === "" ? 0 : 1);
  return (
    <Box
      gap={1}
      aria-role="progressbar"
      aria-label={`${Math.round(ratio * 100)}%`}
      aria-state={{ busy: ratio < 1 }}
    >
      <Text>
        <Text tone="muted">[</Text>
        <Text color={statusPaint(variant)}>
          {(unicode ? "⣿" : "#").repeat(filled)}
          {partial}
        </Text>
        <Text tone="muted">{(unicode ? " " : ".").repeat(remaining)}]</Text>
      </Text>
      {showPercent ? (
        <Text tone="muted">{`${Math.round(ratio * 100)}%`.padStart(4)}</Text>
      ) : null}
      {label === undefined ? null : <Text>{label}</Text>}
      {detail === undefined ? null : <Text tone="muted">{detail}</Text>}
    </Box>
  );
}
