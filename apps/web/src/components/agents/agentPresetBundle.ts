import type { AgentSkill, McpGatewayProfile } from "@t3tools/contracts";
import { ARCHIVE_ENTRY_MAX_BYTES, boundedZip } from "@t3tools/client-runtime/zip/bounded-zip";
import {
  agentPresetFilesFromArchive,
  decodeAgentPresets,
  exportAgentPresets,
  withAgentTemplates,
} from "@t3tools/shared/agentPresets";
import { APP_VERSION } from "../../branding";
import JSZip from "jszip";

// Loaded with a dynamic import so preset text stays out of the main bundle.
const files = import.meta.glob<string>(
  "../../../../../packages/shared/src/agentPresets/{presets,skills}/**/*",
  { query: "?raw", import: "default", eager: true },
);
const root = "../../../../../packages/shared/src/agentPresets/";

const builtIns = decodeAgentPresets(
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path.slice(root.length), text])),
);
export const agentPresets = withAgentTemplates(builtIns, builtIns, APP_VERSION);

/** Reads a .zip holding `presets/<id>/…` and `skills/<name>/…`, at its root or in one folder. */
export async function readAgentPresetArchive(file: Blob) {
  const entries = await boundedZip(await file.arrayBuffer(), ARCHIVE_ENTRY_MAX_BYTES);
  const presets = decodeAgentPresets(
    agentPresetFilesFromArchive([...entries].map(([path, entry]) => [path, entry.bytes] as const)),
  );
  if (presets.length === 0) throw new Error("This archive has no presets/<id>/preset.json.");
  return withAgentTemplates(presets, builtIns, APP_VERSION);
}

/** Downloads agents and the skills they use as a preset archive that Import reads back. */
export async function downloadAgentPresetArchive(
  profiles: ReadonlyArray<McpGatewayProfile>,
  skills: ReadonlyArray<AgentSkill>,
) {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(exportAgentPresets(profiles, skills))) {
    zip.file(`t3-agents/${path}`, text);
  }
  const url = URL.createObjectURL(await zip.generateAsync({ type: "blob" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "t3-agents.zip";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
