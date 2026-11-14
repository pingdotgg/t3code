import type { ModelSelection } from "@t3tools/contracts";
import type { AcpRegistrySettings } from "../settings.ts";

// Without this flag Cursor lists one fixed preset per model, such as
// `claude-opus-5-5[context=300k,effort=medium,fast=false]`. With it Cursor lists
// plain model ids and reports effort, context and fast as config options.
export const cursorClientCapabilitiesMeta = { parameterizedModelPicker: true };

// Local installs launch the `cursor-agent` binary directly with no registry id.
export function isCursorAcpAgent(settings: AcpRegistrySettings): boolean {
  return (
    (settings.source !== "local" && settings.agentId === "cursor") ||
    (settings.source === "local" &&
      /^cursor-agent(\.exe|\.cmd)?$/i.test(settings.commandPath.split(/[\\/]/).pop() ?? ""))
  );
}

// Preserve preset values when opening threads saved before parameterized negotiation.
export function normalizeCursorModelSelection(selection: ModelSelection): ModelSelection {
  const preset = /^(.*)\[([^\]]*)\]$/.exec(selection.model);
  if (preset === null) return selection;
  const explicit = selection.options ?? [];
  const options = preset[2]!.split(",").flatMap((entry) => {
    const [id, value] = entry.split("=");
    return id !== undefined &&
      ["reasoning", "effort", "reasoning_effort", "context", "fast"].includes(id) &&
      value &&
      !explicit.some((option) => option.id === id)
      ? [{ id, value }]
      : [];
  });
  return { ...selection, model: preset[1]!, options: [...options, ...explicit] };
}
