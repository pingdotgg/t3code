import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const DESKTOP_MCP_EXECUTABLE_NAME = "t3-desktop-mcp";

/**
 * Locate the bundled desktop-control MCP server.
 *
 * macOS only: the server drives the Accessibility API, which has no counterpart
 * elsewhere. Resolves to undefined when the binary is absent — the normal case on
 * Linux and Windows, and in checkouts where `pnpm build:desktop-mcp` has not run
 * yet. Callers treat undefined as "do not offer the tools" rather than an error,
 * so there is no failure channel worth typing here.
 */
export const resolveDesktopMcpPath = Effect.fn("desktopControl.resolveDesktopMcpPath")(
  function* () {
    const platform = yield* HostProcessPlatform;
    if (platform !== "darwin") {
      return undefined;
    }

    const environment = yield* HostProcessEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const override = environment.T3CODE_DESKTOP_MCP_PATH;
    const candidates = [
      ...(override ? [override] : []),
      // Packaged: staged into app Resources beside the server bundle.
      path.resolve(import.meta.dirname, DESKTOP_MCP_EXECUTABLE_NAME, DESKTOP_MCP_EXECUTABLE_NAME),
      path.resolve(
        import.meta.dirname,
        "..",
        DESKTOP_MCP_EXECUTABLE_NAME,
        DESKTOP_MCP_EXECUTABLE_NAME,
      ),
      // Dev: SwiftPM output, multi-arch build first then single-arch.
      path.resolve(
        import.meta.dirname,
        "../../../../native/t3-desktop-mcp/.build/apple/Products/Release",
        DESKTOP_MCP_EXECUTABLE_NAME,
      ),
      path.resolve(
        import.meta.dirname,
        "../../../../native/t3-desktop-mcp/.build/release",
        DESKTOP_MCP_EXECUTABLE_NAME,
      ),
      path.resolve(
        import.meta.dirname,
        "../../../native/t3-desktop-mcp/.build/apple/Products/Release",
        DESKTOP_MCP_EXECUTABLE_NAME,
      ),
    ];

    for (const candidate of candidates) {
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        return candidate;
      }
    }
    return undefined;
  },
);
