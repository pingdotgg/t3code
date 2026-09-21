# Device Host Discovery Reliability

**Worktree branch:** `fix/device-host-discovery`

Windows worktree: `E:/Projects/t3code.worktrees/device-host-discovery`.

SSH bootstrap and device commands send their shell scripts through stdin to `sh -s`, so a Windows PowerShell login shell cannot reinterpret POSIX quoting, variables, or the Node version check. Command input is supplied separately inside that script with `printf %s`, preserving quotes, line breaks, and the absence of a trailing newline. SSH aliases must resolve on every selected environment, including a host's own environment, before local-host detection can skip the self connection.

SSH device hosts use one npm invocation path for connection probes and pinned tool installation. Windows runs `npm-cli.js` through the selected Node executable, checking beside Node before PATH directories and preserving paths and arguments containing spaces. Non-interactive POSIX setup appends fallback tool directories so an existing Node/npm pair keeps priority. Bootstrap restores fallback-directory precedence if the selected Node is missing or older than 22, then applies the configured SDK and JVM paths so their tools keep priority. Ordinary device commands do not repeat that version probe. Unsupported-runtime errors include the detected version and executable path. Missing npm, launch failures, signals, and nonzero process exits retain distinct diagnostics, with a bounded stdout fallback when stderr is empty.

Android capability requires SDK Platform-Tools, Android Emulator, and the latest SDK Command-line Tools on local and SSH hosts. An adb-only host reports Android unavailable without disabling iOS. A host with the required tools can retain discovered devices when enumeration of stopped virtual devices fails. When `emulator -list-avds` fails, the shared service retains devices returned by the hub and reports the command, exit code, and a diagnostic tail of at most 2000 characters alongside any hub discovery errors. Successful enumeration still adds unbooted AVDs without duplicating running or repeated entries; a successful refresh clears prior warnings. Local and SSH hosts use the same partial-discovery behavior. Web and desktop show ready-host limitations in both the Device panel and device-host settings. Mobile and agent consumers retain the existing shared device state and wire contract.

Windows hub processes invoke the SDK avdmanager and sdkmanager Java entry points directly, preserving argument boundaries and avoiding the Unix launcher paths used by the pinned hub. This applies to local and SSH hosts; an SSH hub started without the current adapter is replaced on its next startup.

Primary files:

- `apps/server/src/device/sshDeviceScript.ts`
- `apps/server/src/device/SshDeviceHost.ts`
- `apps/server/src/device/LocalDeviceHost.ts`
- `apps/server/src/device/deviceHubWindows.ts`
- `apps/server/src/device/DeviceService.ts`
- `apps/web/src/components/device/DevicePanel.tsx`
- `apps/web/src/components/settings/DeviceHostsSettings.tsx`
- `docs/user/devices.md`

Focused regression coverage:

```sh
vp test run apps/server/src/device/deviceHubWindows.test.ts apps/server/src/device/LocalDeviceHost.test.ts apps/server/src/device/sshDeviceScript.test.ts apps/server/src/device/SshDeviceHost.test.ts apps/server/src/device/DeviceService.test.ts apps/server/src/device/DeviceMultiHost.test.ts
```

Native Windows subprocess coverage checks paths containing spaces, npm PATH fallback, probe and install dispatch, missing npm, and actual npm failure diagnostics. Service fixtures cover missing emulator tooling, tool failures, SSH failures during optional enumeration, preserved iOS and physical Android results, existing hub diagnostics, recovery, and AVD deduplication. POSIX-only shell and lifecycle fixtures require a POSIX host; their bodies do not execute on Windows. The supported/old-Node PATH-selection and SDK/JVM precedence cases were additionally verified with isolated Git Bash shell fixtures on Windows.

Regression coverage executes bootstrap and device-command payloads through the native login shell, including PowerShell on Windows, and checks quoted arguments, exact stdin, and failure propagation. Read-only probes were also verified over real Mac-to-Windows and Windows-to-Mac SSH connections; no helper installation, desktop deployment, or live device session was started.

Capability fixtures cover incomplete and complete SDKs while preserving iOS availability. Windows launcher tests preserve callback and promisified subprocess results and arguments. The real Mac probe reports iOS available and Android unavailable. A read-only Windows check reproduces the original avdmanager ENOENT and successfully lists AVDs through the adapter; full emulator boot has not been verified.
