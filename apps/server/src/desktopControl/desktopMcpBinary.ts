import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const DESKTOP_MCP_EXECUTABLE_NAME = "t3-desktop-mcp";

/**
 * Locate the bundled desktop-control MCP server.
 *
 * macOS ships the Swift package in `native/t3-desktop-mcp`. Windows and Linux
 * ship the Rust crate in `native/t3-desktop-mcp-rs`. Candidate lists are
 * platform-specific so a stray Rust binary on macOS (or Swift on Windows) is
 * never preferred over the functional backend. Resolves to undefined when the
 * binary is absent — callers treat that as "do not offer the tools".
 */
export const resolveDesktopMcpPath = Effect.fn("desktopControl.resolveDesktopMcpPath")(
  function* () {
    const platform = yield* HostProcessPlatform;
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
      return undefined;
    }

    const environment = yield* HostProcessEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const override = environment.T3CODE_DESKTOP_MCP_PATH;
    // Windows keeps the extension; the staged directory name does not.
    const executableName =
      platform === "win32" ? `${DESKTOP_MCP_EXECUTABLE_NAME}.exe` : DESKTOP_MCP_EXECUTABLE_NAME;

    const packaged = [
      // Packaged: staged into app Resources beside the server bundle.
      path.resolve(import.meta.dirname, DESKTOP_MCP_EXECUTABLE_NAME, executableName),
      path.resolve(import.meta.dirname, "..", DESKTOP_MCP_EXECUTABLE_NAME, executableName),
    ];

    const rustDev = [
      path.resolve(
        import.meta.dirname,
        "../../../../native/t3-desktop-mcp-rs/target/release",
        executableName,
      ),
      path.resolve(
        import.meta.dirname,
        "../../../native/t3-desktop-mcp-rs/target/release",
        executableName,
      ),
    ];

    const swiftDev = [
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

    const candidates = [
      ...(override ? [override] : []),
      ...packaged,
      ...(platform === "darwin" ? swiftDev : rustDev),
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
