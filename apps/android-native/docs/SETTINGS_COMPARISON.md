# Native Android settings parity

This document tracks the settings behavior shared by the React Native mobile client (`apps/mobile`) and the native Kotlin Android client (`apps/android-native`). The native UI follows the same product behavior while using Compose and Android-native navigation.

## Current matrix

| Setting | Native Android behavior | Parity note |
| --- | --- | --- |
| T3 Account | Clerk email-code and OAuth sign-in, account state, sign-out | Client path is implemented; production OAuth still requires the native redirect to be allowlisted in Clerk |
| Environments | Dedicated screen with local environment cards, status, edit, reconnect, removal, add action, and empty state | Matches the React Native expandable-row flow |
| T3 Connect environments | Separate relay section with refresh, connect/disconnect switches, saved-relay fallback, and discovery errors | Uses the existing native Clerk, DPoP, and relay client; end-to-end testing remains externally gated |
| Project Grouping | Group by repository, repository path, or keep workspaces separate | Applied to Home, thread project labels, and the new-task project selector |
| Usage | Cross-environment usage screen with selectable time windows | Present |
| Appearance | Shared text size plus terminal and code/diff size overrides, previews, and code word breaking | Text size also controls Markdown and sent user messages; terminal controls share the same persisted setting |
| Legacy thread presentation | Compact thread rows toggle | Native equivalent of choosing the denser thread-list presentation |
| Archived Threads | Cross-environment archive loading, search/filter/sort, restore, and delete | Present |
| Client Storage | Per-environment cache size/count, selective clear, and clear-all with confirmation | Clears offline snapshots without deleting connections, credentials, drafts, or preferences |
| Legal | Legal, Privacy Policy, and Terms of Service links | Opens the canonical documents in the browser |
| Version | Displays the native APK version | Expo OTA update checks do not apply to this independently distributed APK |

## Platform-specific differences

- React Native exposes notification and Live Activity controls where the host platform and account support them. Live Activities are iOS-only; the native Android client does not imitate them.
- The native client intentionally uses the AMOLED dark surface established for this project. Its Appearance screen controls readability typography rather than duplicating unrelated theme choices.
- T3 Connect OAuth cannot be accepted as device-verified until Clerk allows the experimental native application redirect. Direct environments and the relay client implementation do not depend on that approval.

## Verification boundary

Settings presentation and pure grouping/appearance/environment-section behavior are covered by JVM tests and the debug APK build. Destructive environment removal and T3 Connect authentication should be manually accepted on an appropriate test account/device; Android instrumentation must not be run against a personal installation because persistence tests clear app data.
