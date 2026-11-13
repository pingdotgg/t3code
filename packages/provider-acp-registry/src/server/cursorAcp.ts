import type { ModelSelection } from "@t3tools/contracts";

import type { AcpRegistrySettings } from "../settings.ts";

// Without this Cursor lists one fixed preset per model, such as
// `claude-opus-5-5[effort=medium]`, and offers no effort, context or fast option.
export const cursorClientCapabilitiesMeta = { parameterizedModelPicker: true };

// Local installs launch the `cursor-agent` binary directly with no registry id.
export function isCursorAcp(settings: AcpRegistrySettings): boolean {
  return settings.source === "local"
    ? /^cursor-agent(\.exe|\.cmd)?$/i.test(settings.commandPath.split(/[\\/]/).pop() ?? "")
    : settings.agentId === "cursor";
}

/**
 * Threads saved before T3 sent the flag hold a preset id, which Cursor now
 * rejects. Its bracket lists the session options the preset stood for.
 */
export function splitCursorPresetModel(model: string): {
  readonly model: string;
  readonly options: NonNullable<ModelSelection["options"]>;
} {
  const open = model.indexOf("[");
  if (open <= 0 || !model.endsWith("]")) return { model, options: [] };
  return {
    model: model.slice(0, open),
    options: model
      .slice(open + 1, -1)
      .split(",")
      .flatMap((entry) => {
        const separator = entry.indexOf("=");
        return separator <= 0
          ? []
          : [{ id: entry.slice(0, separator), value: entry.slice(separator + 1) }];
      }),
  };
}
