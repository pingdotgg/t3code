import * as React from "react";

import { clip } from "../format.ts";
import type { ModelOption } from "../models.ts";
import { ansi, usePalette } from "../theme.ts";

// The model/provider picker (^K → m), mirroring the web ProviderModelPicker. The
// list is fetched on open from the server config; ↑/↓ choose, Enter applies via
// updateThreadMetadata. Purely presentational — fetch + selection live in ChatView.

export type ModelPickerStatus = "loading" | "ready" | "error" | "empty";

const WINDOW = 8;

export const ModelPicker = React.memo(function ModelPicker({
  options,
  selected,
  status,
  currentInstanceId,
  currentModel,
  width,
}: {
  readonly options: ReadonlyArray<ModelOption>;
  readonly selected: number;
  readonly status: ModelPickerStatus;
  readonly currentInstanceId: string | null;
  readonly currentModel: string | null;
  readonly width: number;
}): React.ReactNode {
  const palette = usePalette();
  const labelRoom = Math.max(8, width - 12);

  let body: React.ReactNode;
  if (status === "loading") {
    body = <text fg={palette.dim}>loading models…</text>;
  } else if (status === "error") {
    body = <text fg={ansi("red")}>failed to load models</text>;
  } else if (status === "empty" || options.length === 0) {
    body = <text fg={palette.dim}>no models reported by the server</text>;
  } else {
    const start = Math.min(
      Math.max(0, selected - Math.floor(WINDOW / 2)),
      Math.max(0, options.length - WINDOW),
    );
    const visible = options.slice(start, start + WINDOW);
    body = (
      <>
        {visible.map((option, offset) => {
          const index = start + offset;
          const active = index === selected;
          const current =
            option.instanceId === currentInstanceId && option.model === currentModel;
          return (
            <text key={`${option.instanceId}:${option.model}`}>
              <span fg={active ? palette.accent : palette.dim}>{active ? "▸ " : "  "}</span>
              <span fg={current ? ansi("green") : palette.dim}>{current ? "✓ " : "  "}</span>
              <span fg={active ? palette.text : palette.dim}>{clip(option.label, labelRoom)}</span>
              <span fg={palette.dim}>{`  ${option.providerLabel}`}</span>
            </text>
          );
        })}
      </>
    );
  }

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
        <span fg={palette.accent}>model ▸ </span>
        <span fg={palette.dim}>↑/↓ select · Enter apply · Esc cancel</span>
      </text>
      {body}
    </box>
  );
});
