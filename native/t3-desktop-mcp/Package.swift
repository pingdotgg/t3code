// swift-tools-version:5.9
import PackageDescription

// Desktop control MCP server. macOS only: it talks to the Accessibility API,
// which has no counterpart on other platforms, so the build is gated on darwin
// by the desktop artifact script rather than by a runtime check here.
let package = Package(
  name: "t3-desktop-mcp",
  // macOS 14 for SCScreenshotManager, which replaces the deprecated
  // CGWindowListCreateImage path for window capture.
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "t3-desktop-mcp",
      path: "Sources",
    ),
  ],
)
