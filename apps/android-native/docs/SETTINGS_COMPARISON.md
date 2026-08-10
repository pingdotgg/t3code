# T3 Code Android Native — Settings Parity & Feature Comparison

This document tracks feature parity and UI/functional differences between the React Native app (`apps/mobile`) and the Native Kotlin Android app (`apps/android-native`) for the **Settings** feature set.

---

## 📊 Summary Comparison Matrix

| Setting / Feature                          | React Native (`apps/mobile`)                                               | Native Kotlin (`apps/android-native`)                           | Status & Differences                                                        |
| :----------------------------------------- | :------------------------------------------------------------------------- | :-------------------------------------------------------------- | :-------------------------------------------------------------------------- |
| **Account & T3 Connect**                   | Full Clerk authentication sheet & email/OAuth login                        | Custom `ConnectAuthScreen` with email verification code + OAuth | **Present in both** (Kotlin uses a native screen; RN uses Clerk Expo)       |
| **Environments Management**                | Dedicated `SettingsEnvironments` route screen                              | Inline environment cards + `EnvironmentDrawer` bottom sheet     | **Present in both** (Kotlin allows inline switching & sheet editing)        |
| **Device Notifications & Live Activities** | Gated toggles for iOS push notifications & Live Activities                 | ❌ Not included                                                 | **RN only** (iOS-specific features)                                         |
| **Usage Stats**                            | `SettingsUsage` sub-screen                                                 | `UsageScreen` sub-screen                                        | **Present in both**                                                         |
| **Appearance / Theming**                   | `SettingsAppearance` screen (System / Dark / Light, Theme Accent colors)   | Static "AMOLED dark" + **"Compact thread rows"** toggle         | **Different**: RN has theme/accent picker; Kotlin has compact row toggle    |
| **Project Grouping**                       | `SettingsProjectGrouping` sub-screen (Group by project, collapse defaults) | ❌ Missing sub-screen (has an "Add project" shortcut button)    | **RN only** (Kotlin lists projects in filter bottom sheet)                  |
| **Legacy Features**                        | **"Legacy Thread List"** toggle (flat vs grouped v1 thread list)           | ❌ Missing                                                      | **RN only**                                                                 |
| **Archived Threads**                       | `SettingsArchive` sub-screen                                               | `ArchivedThreadsScreen` sub-screen                              | **Present in both** (Kotlin supports cross-environment search & unarchive)  |
| **Storage Management**                     | `SettingsClientStorage` screen (DB size, vacuum, detailed cache clear)     | Inline stats + **"Clear cached snapshots"** button              | **RN has full storage detail screen**; Kotlin has inline clear cache button |
| **Legal & Policies**                       | `SettingsLegal` screen with interactive document view                      | Static text note                                                | **RN has full document viewer**                                             |
| **App OTA Updates**                        | Version row with hidden tap to check Expo updates                          | ❌ N/A (Native APK / ADB updates)                               | **RN only**                                                                 |
| **Beta Toggles**                           | ❌ None                                                                    | **"Native beta features"** toggle                               | **Kotlin only**                                                             |

---

## 🔍 Detailed Feature Breakdown

### 1. Account & T3 Connect

- **React Native:** Uses `@clerk/expo` and an Expo bottom sheet for authentication and managing cloud accounts.
- **Kotlin Native:** Implements `ConnectAuthScreen` directly in Compose with email code authentication and Apple/GitHub/Google/Microsoft OAuth options.

### 2. Environments Management

- **React Native:** Links to a separate screen (`SettingsEnvironmentsRouteScreen`) listing saved remote connections.
- **Kotlin Native:** Displays saved environments as interactive cards directly in the main Settings screen, with an `EnvironmentDrawer` modal sheet for editing label/URL or forgetting environments.

### 3. Appearance & Theming

- **React Native:** `SettingsAppearanceRouteScreen` supports choosing System/Light/Dark mode and selecting custom accent colors.
- **Kotlin Native:** Fixed dark AMOLED color palette with a dedicated toggle for **Compact thread rows**.

### 4. Project Grouping

- **React Native:** `SettingsProjectGroupingRouteScreen` provides preferences for thread grouping logic and collapse defaults.
- **Kotlin Native:** Provides an "Add project" button in Settings; project selection/filtering is handled via the Home thread filter bottom sheet.

### 5. Storage & Persistence

- **React Native:** `SettingsClientStorageRouteScreen` presents database metrics (SQLite size, cache allocations) and buttons for selective clearing and vacuuming.
- **Kotlin Native:** Displays summary stats (environment count, pending task count) and a **"Clear cached snapshots"** button.

### 6. Legal & Documentation

- **React Native:** Navigates to `SettingsLegalRouteScreen` to read Terms of Service and Privacy Policy markdown documents.
- **Kotlin Native:** Includes a static note regarding open-source licenses and privacy info.
