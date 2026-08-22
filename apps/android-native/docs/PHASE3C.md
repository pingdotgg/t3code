# Phase 3C — Terminal

## Goal

Let a user open and control the server-owned shell for a thread's effective workspace without leaving the native Android app. Leaving the screen detaches the client; it does not kill the process.

## Capability matrix

| Journey            | Server contract                   | Android behavior                                                                                             |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Discover sessions  | `subscribeTerminalMetadata`       | Lists the thread's terminals with server status, label, cwd, and running-subprocess state                    |
| Open or reattach   | `terminal.attach`                 | Opens `term-1` when absent, reattaches a live session, or restarts an exited session with history replay     |
| Render output      | Attach snapshot and output events | Resets from authoritative history, then feeds output directly into the shared Ghostty renderer               |
| Send input         | `terminal.write`                  | Sends IME, hardware-key, pasted, and accessory-button input without optimistic echo                          |
| Resize             | `terminal.resize`                 | Uses measured Ghostty cell geometry and keeps only the latest outstanding resize                             |
| Clear              | `terminal.clear`                  | Clears server history and the renderer after the matching stream event                                       |
| Restart            | `terminal.restart`                | Restarts in the server-reported cwd and reconciles from the restarted snapshot                               |
| Close              | `terminal.close`                  | Closes explicitly; Back only detaches. Running subprocesses require confirmation                             |
| Multiple terminals | Client-selected `term-N` ids      | Creates the first free numeric id, switches sessions, and falls back to the previous live session after exit |

The attach reducer keeps a UTF-8-safe 512 KiB replay suffix. Output commands travel through a terminal-only stream rather than the global application state, so Compose chrome does not receive the growing terminal buffer.

## Shared renderer

The Expo terminal view was split into a plain `TerminalSurfaceView` and a thin Expo event adapter. Native Android's `:terminal-renderer` module compiles the same Ghostty bridge, JNI source, Canvas renderer, fonts, and prebuilt `libghostty-vt` artifacts directly from the RN module. The JNI package remains `expo.modules.t3terminal`, so the native symbol ABI is unchanged.

The Compose screen hosts `TerminalSurfaceView` through `AndroidView`. Snapshot/restart events reset the VT, output events append, and clear events clear it. View recreation replays the controller's bounded buffer. Ghostty and Meslo license notices remain in `apps/mobile/modules/t3-terminal/THIRD_PARTY_NOTICES.md` beside the shared artifacts.

## RN accessory parity

The keyboard accessory row matches RN Android in this order:

```text
esc  ctrl  alt  tab  clear  ↑  ↓  ←  →  ~  |  /  -  keyboard-hide
```

For a macOS-labeled host, `cmd` replaces `alt` and precedes `ctrl`. `ctrl` and `alt`/`cmd` visibly latch for one input. The modifier applies continuously across both the accessory row and the Android software keyboard: for example, tapping `ctrl` and then typing `c` sends byte `0x03`. A used modifier clears; tapping the active modifier again cancels it. Ctrl mappings for A–Z and `@ [ \ ] ^ _ ?` match RN. Alt/Cmd prefixes the next input with Escape.

`clear` calls the server rather than wiping the view locally. The accessory follows the software keyboard, includes a dismiss button, and exposes a floating keyboard button when hidden.

## Lifecycle

- The thread toolbar opens `term-1`.
- The terminal route resolves cwd from existing terminal metadata, then the thread worktree, then the project root.
- Attach and metadata subscriptions restart through the existing environment supervisor after reconnect.
- Writes are serialized per visible route. Resize is latest-wins. Lifecycle mutations are single-flight and are not blindly retried.
- Back cancels client subscriptions only. The server process and history remain available on reopen.
- A live `exit` closes the session and navigates to the previous live terminal or back to the thread.
- Restart and close ask for confirmation when server metadata reports a running subprocess.
- Terminal text size is persisted with the native app settings from 6–14 pt in 0.5 pt steps.

## Verification

Focused local gate:

```bash
./gradlew :protocol:test :app:testDebugUnitTest \
  :app:compileDebugAndroidTestKotlin :app:assembleDebug
```

The protocol tests cover exact wire decoding, payloads, session-id allocation, metadata reduction, lifecycle reduction, and UTF-8-safe history trimming. App tests cover numeric session ordering, previous-live fallback, host modifier selection, Ctrl byte mappings, and modifier consumption across Android keyboard input.

The on-device `TerminalSurfaceViewTest` creates the shared renderer, loads JNI, feeds ANSI and Unicode output, changes geometry, and destroys the renderer. The opt-in `AndroidProtocolIntegrationTest` accepts `terminalThreadId` and `terminalCwd` instrumentation arguments and exercises open, write/attach output, resize, clear, restart, and close against a disposable server.

Manual acceptance on the connected Android device covers cwd, ANSI/Unicode, keyboard input, `ctrl` + keyboard `c`, all accessory buttons, resize, scrollback/selection/copy, clear, Back/reopen history, reconnect, multiple terminals, restart/close confirmation, and natural exit fallback.

## Boundaries

Phase 3C does not add desktop terminal split panes, project-script launchers, environment-variable editing, URL detection, global hardware shortcuts, review UI, file writes, or attachment picker/upload. T3 Connect administrator approval is not a gate. Performance measurement remains deferred until all Phase 3 slices are complete.
