// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_MCP = process.platform === "win32" ? "t3-desktop-mcp.exe" : "t3-desktop-mcp";

/**
 * Locate the bundled/dev desktop MCP binary for Computer History daemon spawn.
 * Mirrors server resolution but stays sync for Electron main.
 */
export function resolveDesktopMcpBinaryPathSync(): string | undefined {
  const override = process.env.T3CODE_DESKTOP_MCP_PATH;
  if (override && NodeFs.existsSync(override)) return override;

  const here = NodePath.dirname(fileURLToPath(import.meta.url));
  const candidates =
    process.platform === "darwin"
      ? [
          NodePath.resolve(
            here,
            "../../../../native/t3-desktop-mcp/.build/apple/Products/Release",
            DESKTOP_MCP,
          ),
          NodePath.resolve(here, "../../../../native/t3-desktop-mcp/.build/release", DESKTOP_MCP),
          NodePath.resolve(
            here,
            "../../../native/t3-desktop-mcp/.build/apple/Products/Release",
            DESKTOP_MCP,
          ),
          NodePath.resolve(process.resourcesPath ?? "", "t3-desktop-mcp", DESKTOP_MCP),
        ]
      : [
          NodePath.resolve(
            here,
            "../../../../native/t3-desktop-mcp-rs/target/release",
            DESKTOP_MCP,
          ),
          NodePath.resolve(here, "../../../native/t3-desktop-mcp-rs/target/release", DESKTOP_MCP),
          NodePath.resolve(process.resourcesPath ?? "", "t3-desktop-mcp", DESKTOP_MCP),
        ];

  for (const candidate of candidates) {
    if (NodeFs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
