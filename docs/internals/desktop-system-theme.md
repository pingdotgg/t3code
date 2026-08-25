# Desktop system theme

> For maintainers. Using T3 Code? See [Follow the system theme](../user/system-themes.md).

System palette integration belongs to the Electron shell because the palette describes the machine rendering T3 Code, not an environment running an agent.

On Linux, the desktop main process reads the active Omarchy `colors.toml` from the user's local state directory and watches the stable parent directory with `fs.watch`. It retains the last valid palette through short atomic-replacement gaps and publishes changes to every window.

The preload bridge exposes a synchronous current snapshot for flash-free boot and an optional change subscription for the running renderer. The web theme library shows **Follow system theme** only while that snapshot is available.

The palette does not cross the server WebSocket, HTTP API, or `ServerConfig`. Remote web and mobile clients therefore keep their own theme, and non-Linux desktop builds do not start a watcher.
