---
name: ios-debugger-agent
description: Build, launch, inspect, and drive iOS apps with the repository-configured XcodeBuildMCP server. Use on macOS for iOS Simulator builds, focused native test runs, semantic UI automation, screenshots, logs, or debugging, including T3 Code Mobile verification.
---

# iOS Debugger Agent

Use the repository-configured `xcodebuildmcp` tools instead of requiring a globally installed Codex plugin. Prefer MCP tools over raw `xcodebuild`, `xcrun`, or `simctl` when the client exposes them.

## Confirm availability

This workflow requires macOS 14.5 or newer, Xcode 16 or newer, and Node.js 18 or newer. The repository pins XcodeBuildMCP in both `.mcp.json` for Claude Code and `.codex/config.toml` for Codex. Project MCP servers may require one-time trust or approval followed by a new session.

If the tools are missing:

1. Confirm the repository is trusted and its project MCP server was approved.
2. Restart or recreate the agent session after approving configuration.
3. Run `npx --yes xcodebuildmcp@2.6.2 doctor` when the server starts but simulator or UI-automation tools are unavailable. Follow its actionable Xcode or AXe setup guidance.
4. Fall back to the pinned XcodeBuildMCP CLI or native Apple CLIs only when the current agent client cannot expose project MCP tools.

Do not ask contributors to install the OpenAI `build-ios-apps` plugin globally.

## Establish one simulator context

1. Call `session_show_defaults` before discovery, build, launch, or UI work.
2. Call `list_sims` and select one explicit simulator UDID. Prefer a simulator that is already booted; boot an installed simulator when verification requires it, but do not create or download runtimes without user authorization.
3. Call `session_set_defaults` with the project or workspace, scheme, Debug configuration, simulator ID, and bundle identifier when known.
4. Keep every subsequent build, launch, screenshot, log capture, and UI action pinned to that same UDID.

Avoid generic Mac window automation for switching among Simulator windows. Explicit device identity is more reliable.

## Choose build or launch

- Use `build_run_sim` when native source, native dependencies, entitlements, or project configuration changed.
- Use `test_sim` for the smallest relevant native test target or test cases; do not run an entire workspace test matrix routinely.
- Use `launch_app_sim` when a compatible app is already installed and no native rebuild is needed.
- To reuse an existing build artifact, use `get_sim_app_path` or `get_app_bundle_id`, install it with `install_app_sim` when necessary, and then launch it.
- Do not run a build-only action immediately before `build_run_sim` unless the task requires both artifacts.

After launch, call `snapshot_ui` or `screenshot` before interacting. An open Simulator window alone is not evidence that the intended app launched.

## Drive the UI semantically

1. Call `snapshot_ui` to obtain the current accessibility hierarchy and element references.
2. Use only current `elementRef` values whose snapshot entries list the intended action. XcodeBuildMCP `2.6.2` does not accept coordinates for `tap`; when the app exposes no actionable reference, prefer a registered deep link or another app-supported route and otherwise report the accessibility blocker.
3. Refresh with `snapshot_ui` after navigation or layout changes. Element references are snapshot-specific.
4. Use `wait_for_ui` for asynchronous transitions when available rather than fixed sleeps.
5. Capture a final `screenshot` for the state that proves the affected flow.

Use `gesture` or scoped swipe actions when needed. If a gesture is unreliable, return to a known route or relaunch rather than switching to generic desktop automation.

## Capture logs and debug

- Use `start_sim_log_cap` and `stop_sim_log_cap` with the exact bundle identifier for focused runtime logs.
- Use debugger tools only when the task requires runtime diagnosis; attach to the selected simulator and app rather than an ambiguous process.
- Summarize relevant errors instead of returning unbounded logs.

## Clean up

Stop only log captures, debugger sessions, apps, or simulators started for the current test. Leave pre-existing simulators and unrelated sessions alone.

## Upstream

Adapted from OpenAI's [`build-ios-apps`](https://github.com/openai/plugins/tree/main/plugins/build-ios-apps) plugin version `0.1.2` (`ios-debugger-agent`, MIT) and aligned with XcodeBuildMCP `2.6.2` tool names.
