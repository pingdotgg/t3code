# iOS Simulator toolkit

The server exposes a provider-neutral MCP surface for exercising an iOS Simulator on a macOS host. The session tools are `simulator_open`, `simulator_tap`, `simulator_swipe`, `simulator_type`, `simulator_screenshot`, `simulator_video_start`, `simulator_video_stop`, `simulator_logs`, `simulator_metrics`, and `simulator_close`.

`simulator_open` boots an available device and can install and launch an `.app` bundle. Input actions use macOS screen coordinates through System Events, so the host needs Accessibility permission for the process running T3. Screenshots, videos, and logs stay in a per-session temporary artifact directory after `simulator_close`. Tool results return the absolute path, byte count, and SHA-256 digest.

The host boundary is macOS-only. Other hosts return a typed `unsupported_host` error. The quick real-host check is:

```sh
pnpm verify:simulator -- --device "iPhone 17 Pro"
```

It boots the named device when needed and proves screenshot, log, and metric collection. Input automation is intentionally opt-in through the MCP tools because it can move the user's pointer and requires Accessibility permission.

The service keeps one typed session record per simulator and serializes input actions with a per-session semaphore. A resident launchd daemon was considered, but would add installation, discovery, and protocol versioning before T3 needed those capabilities. The existing authenticated MCP server already provides the provider-neutral transport, so the server-owned host service keeps the first implementation smaller and easier to verify.
