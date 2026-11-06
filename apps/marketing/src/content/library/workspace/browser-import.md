---
title: "Import browser sessions"
description: "Import browser cookies into T3 Code preview profiles, reuse signed-in sessions, and handle Safari permissions and Windows restrictions."
updated: 2026-11-04
sources:
  - label: "Import browser sessions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/browser-import.md"
  - label: "Supported browser source definitions"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/preview/BrowserImport/Sources.ts"
  - label: "Browser profile settings and import actions"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/settings/IntegrationsSettings.tsx"
  - label: "Settings and device preferences"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md"
faq:
  - question: "How do I import a browser login into T3 Code?"
    answer: "In the T3 Code desktop app, open Settings → Browser → Browser profiles → Add profile and choose a browser under Import from. Close the source browser and allow a keyring unlock prompt if one appears."
  - question: "Does T3 Code keep browser sessions synchronized?"
    answer: "T3 Code browser import copies cookies once. Later login changes remain separate, and some sites may still require another sign-in."
  - question: "Can T3 Code import Chrome cookies on Windows?"
    answer: "The documented Windows imports in T3 Code are Firefox, Zen, and Helium profiles using standard profile encryption. Other Chromium-based browsers use app-bound encryption and cannot be imported."
  - question: "Why does T3 Code need Full Disk Access for Safari import?"
    answer: "T3 Code requires macOS Full Disk Access to import Safari cookies. You can revoke that access after the import finishes."
---

T3 Code can import cookies from another browser into its preview browser so you can reuse signed-in sessions. Import is a one-time copy in the desktop app, and some sites may still ask you to sign in again.

## Import a browser profile

1. Close the browser you want to import from.
2. Open `Settings → Browser → Browser profiles → Add profile` in T3 Code.
3. Choose the browser under `Import from`.
4. Follow the import wizard for the source profile and destination.
5. Allow an operating-system keyring unlock prompt if one appears.
6. Open the site in the preview browser and check its signed-in state.

Choose the source profile that contains the account you need. Browser profiles separate cookies and logins. If you use different accounts for work and personal browsing, verify the imported account on the site before continuing the task.

You need a connected environment to import cookies. The settings interface excludes unsupported or uninstalled browser sources. A browser missing from the menu is therefore a reason to check platform support and the source installation, rather than assuming all desktop browsers are importable.

## Check browser support for your operating system

The source definitions specify these platform combinations:

| Platform | Browser sources                                                                  |
| -------- | -------------------------------------------------------------------------------- |
| macOS    | Chrome, Microsoft Edge, Brave, Vivaldi, Opera, Arc, Helium, Safari, Firefox, Zen |
| Linux    | Chrome, Microsoft Edge, Brave, Vivaldi, Opera, Helium, Firefox, Zen              |
| Windows  | Firefox, Zen, Helium                                                             |

The Windows restriction concerns encryption. Other Chromium-based Windows browsers use app-bound encryption that prevents import. Supported Windows profiles must use standard profile encryption.

Support for a browser does not guarantee every site session transfers. Partitioned cookies are skipped on every platform. Some sites require another sign-in even after the import completes. Test the particular site you need instead of treating a completed import as proof that every account is available.

## Allow Safari import on macOS

Safari import needs Full Disk Access. Follow the permission step in the import flow:

1. Choose `Allow`.
2. Drag T3 Code into the System Settings permission list.
3. Turn access on.
4. Return to the import flow when `Continue` becomes available.

macOS may require you to quit and reopen T3 Code before the grant applies. Reopen the import wizard after restarting the app. You can revoke Full Disk Access once the import is complete.

This permission belongs to Safari import. [SnapShots](/learn/workspace/snapshots) uses a separate capture setup with different permissions. Check the feature requesting access so you change the relevant setting.

## Understand what changes after the copy

The source browser and preview browser keep separate login state after import. A later login change in one does not automatically update the other. If the source browser signs into a different account, verify which account remains active inside T3 Code.

The import feature copies cookies for session reuse. Do not treat it as a promise to migrate bookmarks, extensions, browsing history, or every piece of site state. Its documented result is the ability to reuse eligible signed-in sessions.

Browser profile preferences are device settings. They appear independently of the project and environment selection used by server settings. Read [settings and project overrides](/learn/customize/project-settings) when you need to distinguish a device preference from an environment default.

## Troubleshoot a missing login

Start with the source profile. Confirm that the site was signed in there before import. Close the source browser, then check whether the wizard requests a keyring unlock or a Safari permission step.

On Windows, compare the source against the supported list before trying again. Repeating an import cannot bypass app-bound encryption. On any platform, a site may need you to sign in inside the preview browser because its required session state did not transfer.

Choose the appropriate workflow for the task. Use [visual replies](/learn/workspace/visual-replies) for an HTML explanation. Use [default-browser routing](/learn/workspace/default-browser) to bring links from other Mac apps into T3 Code. Neither action replaces cookie import when your task requires an existing login.

## Next steps

- Use the [workspace overview](/learn/workspace) to compare browser sessions, screenshots, and rendered answers.
- Capture a specific problem with [SnapShots](/learn/workspace/snapshots) when an image is enough context for the agent.
