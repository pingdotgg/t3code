import * as NodeBuffer from "node:buffer";
import { ExtensionOperationError } from "@t3tools/contracts";
import type { InstalledTool } from "./EnvironmentExtensions.ts";

/** Cursor is the last returned tool ID; oversized descriptors fail instead of disappearing. */
export function catalogPage(catalog: readonly InstalledTool[], cursor?: string) {
  const remaining = catalog
    .filter((tool) => cursor === undefined || tool.descriptor.id > cursor)
    .toSorted((a, b) =>
      a.descriptor.id < b.descriptor.id ? -1 : a.descriptor.id > b.descriptor.id ? 1 : 0,
    );
  const tools: InstalledTool[] = [];
  let nextCursor: string | null = null;
  for (let index = 0; index < remaining.length; index++) {
    const tool = remaining[index]!;
    const next = index + 1 < remaining.length ? tool.descriptor.id : null;
    const candidate = { tools: [...tools, tool], nextCursor: next };
    if (NodeBuffer.Buffer.byteLength(JSON.stringify(candidate), "utf8") > 65536) {
      if (tools.length === 0)
        throw new ExtensionOperationError({
          operation: "mcp.list",
          detail: "One extension tool descriptor exceeds the MCP catalog page budget.",
        });
      nextCursor = tools.at(-1)!.descriptor.id;
      break;
    }
    tools.push(tool);
    nextCursor = next;
  }
  return { tools, nextCursor };
}
