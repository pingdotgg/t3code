import type {
  ProjectId,
  ResolvedMcpServer,
  ServerSettings,
  ThreadToolPresets,
} from "@t3tools/contracts";
import { applyThreadToolPresets } from "@t3tools/shared/agentTools";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import type { McpProviderSessionTools } from "@t3tools/provider-core/server/mcpSession";

/**
 * A thread's tools from secret-materialized settings: project overrides, then
 * the thread's presets, disabled servers dropped. The fingerprint covers the
 * full config (a rotated secret counts) and is only compared, never sent.
 */
export function resolveAgentTools(
  settings: ServerSettings,
  projectId: ProjectId | null,
  threadPresets?: ThreadToolPresets,
): McpProviderSessionTools {
  const effective = applyThreadToolPresets(
    resolveProjectSettings(settings, projectId).settings,
    settings.toolPresets,
    threadPresets,
  );
  const servers: ResolvedMcpServer[] = Object.entries(effective.mcpServers)
    .filter(([, server]) => server.enabled)
    .map(([name, server]) => ({ name, transport: server.transport }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const disabledSkills = [...new Set(effective.disabledSkills)].toSorted();
  const fingerprint =
    servers.length === 0 && disabledSkills.length === 0
      ? ""
      : JSON.stringify({ servers, disabledSkills });
  return { servers, disabledSkills, fingerprint };
}
