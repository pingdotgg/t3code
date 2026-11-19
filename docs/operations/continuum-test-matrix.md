# Continuum game development preview test matrix

## Build and package checks

| Target                           | Evidence                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NixOS dev build                  | Web and server started against an isolated home. Changed-file checks passed on the first preview commit.                                                                                   |
| Ubuntu 24.04.5 and Fedora 44     | Both official cloud images booted under QEMU/KVM, completed cloud-init, and accepted SSH. Packaged app installation requires the release artifacts.                                        |
| Linux x64 AppImage, DEB, and RPM | All three built in the first preview run. The updater manifest check failed because the RPM pass overwrote the AppImage manifest. The release workflow now restores the AppImage manifest. |
| Windows x64                      | NSIS installer built in the first preview run. The workflow also checks silent install and renderer launch on the next run.                                                                |
| macOS arm64 and x64              | The release jobs install through Homebrew, launch with `contin`, and uninstall. See the release run for runner and build results.                                                          |
| iOS simulator                    | The manual platform smoke job builds the arm64 simulator app from source and checks its platform.                                                                                          |
| Stock Android beta 2.3.0 (784)   | The manual platform smoke job installs the checksum-pinned APK and waits for an authenticated WebSocket on an isolated Continuum host.                                                     |

See the [first preview run](https://github.com/SwashX-dev/continuum-ide/actions/runs/44583075275)
and [stock Android release](https://github.com/pingdotgg/t3code/releases/tag/android-beta-784).

## Live workflows

| Workflow        | Evidence                                                                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IWE on NixOS    | Built-in Browser panel paired with the scratch server. Opened the existing garden in place and installed IWE 0.33.0 through the managed installer. Confirmed search, preview links and backlinks, completion, save, link-target rename, and note attachment.                                                                                  |
| IWE agent tools | Claude Haiku 4.5 started the thread. Codex GPT-6 Luna completed find, retrieve, and update after Haiku reached its usage limit. Notes showed **Agent updated** and `iwe retrieve` confirmed the exact added bullet after reopening. The workspace config retained SHA-256 `a5c3014043fc1065eed5626166a41635b63232632083293976882bb0057ddebe`. |
| Blender         | Focused integration test used Blender 5.2.3 for model and material operations, asset export, and preview. Import was checked through the simulated Unreal editor.                                                                                                                                                                             |
| Web UI          | Built-in Browser panel opened Game Development settings and the workspace panel, Mobile Access settings, and Entertainment Center. Each original game accepted input inside its sandboxed frame.                                                                                                                                              |

## Simulated and automated checks

| Area                     | Coverage                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unreal bridge            | Real Python plugin using the simulated editor fixture. Exercised connect, approvals, scene operations, playtest, captures, tests, checkpoints, and asset import. |
| Agent Eyes               | Unit coverage for classifying game and asset MCP calls and extracting the capture ID from game tool output.                                                      |
| Desktop guest isolation  | Window tests check the dedicated Entertainment partition, preload removal, context isolation, and invalid navigation rejection at attach time.                   |
| Release smoke            | `vp run release:smoke` checks the release manifests, workspace install, and configuration extraction fixtures.                                                   |
| Server and wire behavior | Focused WebSocket, MCP HTTP, agent-context budget, IWE, and Game Development tests.                                                                              |

## Blocked live checks

| Workflow                              | Blocker                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Live Roblox Studio, Unity, and Unreal | Editor accounts, licenses, and installed editor builds are needed.                                               |
| ForgeGUI generation and publishing    | Requires a scoped ForgeGUI API key, credits, and a Roblox publishing connection.                                 |
| Interactive native mobile checks      | The local Device panel reported that agent device access was disabled. The hosted CI jobs can run independently. |

Load QEMU and xorriso on NixOS, then run `scripts/continuum-cloud-smoke.sh ubuntu` or
`scripts/continuum-cloud-smoke.sh fedora`. Pass the corresponding `.deb` or `.rpm` as the
second argument to install and launch the packaged app. Dispatch **Continuum CI** with
`platform_smoke=true` for the Android and iOS jobs.
