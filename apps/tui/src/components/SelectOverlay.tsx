import type { SelectOption } from "@opentui/core";
import * as React from "react";

import { ansi, usePalette } from "../theme.ts";

// A picker built on OpenTUI's native <select> — used for the composer controls
// (model / runtime access / reasoning), mirroring the web's name+description
// dropdowns. The <select> owns ↑/↓ + Enter; ChatView handles only Esc.

export type SelectStatus = "loading" | "ready" | "empty" | "error";

export const SelectOverlay = React.memo(function SelectOverlay({
  title,
  status,
  options,
  selectedIndex,
  height,
  onSelect,
}: {
  readonly title: string;
  readonly status: SelectStatus;
  readonly options: ReadonlyArray<SelectOption>;
  readonly selectedIndex: number;
  readonly height: number;
  readonly onSelect: (index: number, option: SelectOption | null) => void;
}): React.ReactNode {
  const palette = usePalette();
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={palette.accent}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text>
        <span fg={palette.accent}>{`${title} ▸ `}</span>
        <span fg={palette.dim}>↑/↓ select · Enter apply · Esc cancel</span>
      </text>
      {status === "loading" ? (
        <text fg={palette.dim}>loading…</text>
      ) : status === "error" ? (
        <text fg={ansi("red")}>failed to load</text>
      ) : status === "empty" || options.length === 0 ? (
        <text fg={palette.dim}>nothing to choose</text>
      ) : (
        <select
          focused
          options={options as SelectOption[]}
          selectedIndex={Math.max(0, Math.min(selectedIndex, options.length - 1))}
          height={Math.max(2, height)}
          showDescription
          wrapSelection
          showScrollIndicator
          selectedBackgroundColor={palette.selectedBg}
          focusedBackgroundColor={palette.selectedBg}
          descriptionColor={palette.dim}
          onSelect={onSelect}
        />
      )}
    </box>
  );
});
