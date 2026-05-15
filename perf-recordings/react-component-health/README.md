# React component health recording: provider instance dialog

This directory contains the react-scan comparison for the provider instance dialog rerender fix.

- `before-provider-dialog.webm`: recorded from commit `556c42452c5ac94ae8d8698d64fcd372c1680955`.
- `after-provider-dialog.webm`: recorded from commit `be215fb3ea877f46cf7491148b6fdcfa54ab5eae`.

Capture setup:

- Vite served the app in hosted-static mode (`VITE_HOSTED_APP_CHANNEL=latest`) so the settings route could load without a backend.
- The page HTML was intercepted by Playwright and injected with `react-scan@0.5.6` before the React bundle.
- The scripted interaction opened Settings > Providers, opened "Add provider instance", advanced to the identity step, typed "Performance Workspace" into the label field, then edited the instance ID.

Measured during label typing with the React DevTools hook:

- Before: 34 `AddProviderInstanceDialog` render commits.
- After: 23 `AddProviderInstanceDialog` render commits.
