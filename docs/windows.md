# Windows operations & resilience

Operational notes for running and packaging T3 Code on Windows. These complement
the platform-hardening applied in code (spawn safety, process-tree kills,
Electron fuses, V8 compile cache, per-user install, and git long-path support).

## Install & code signing (AV / SmartScreen)

- **Signed releases.** Windows artifacts are signed with Azure Trusted Signing
  (`winConfig.azureSignOptions` in `scripts/build-desktop-artifact.ts`). A valid
  Authenticode signature is what lets SmartScreen build reputation; unsigned
  local builds set `signAndEditExecutable: false` and will trip SmartScreen.
- **Per-user install.** The NSIS installer is configured per-user
  (`perMachine: false`, see `resolveWindowsNsisConfig`), installing to
  `%LOCALAPPDATA%\Programs\<appId>`. This needs no admin elevation (no UAC
  prompt), keeps the install path short, and writes to a user-writable location.
- **Differential updates.** `differentialPackage` emits `.blockmap` sidecars so
  electron-updater downloads only changed blocks, shrinking update bandwidth and
  the number of freshly-written files Defender must rescan. It is enabled only
  when a publish/updater target is configured (`resolveWindowsNsisConfig`
  receives whether `buildConfig.publish` is set). electron-builder makes
  differential-aware builds require updater metadata, so an unpublished fork/dev
  build (no `T3CODE_DESKTOP_UPDATE_REPOSITORY` / `GITHUB_REPOSITORY`, no mock
  updates) packages with `differentialPackage: false` and does **not** need any
  repository configuration. To build a fork installer that still generates
  update metadata, set `T3CODE_DESKTOP_UPDATE_REPOSITORY=<owner>/<repo>` (e.g.
  `ronak-guliani/t3code`).
- **Minimize bundled binaries.** Fewer shipped native binaries means less
  SmartScreen/AV surface. Keep the packaged dependency set lean; the app is
  bundled into `app.asar` (default) so loose executables are the exception, not
  the rule. Audit new native deps before adding them to the desktop bundle.

## Long paths (`MAX_PATH` / 260-char limit)

Deep `node_modules` trees inside git worktrees can exceed the legacy 260-char
path limit. The app mitigates this on multiple layers:

- **Shallow roots.** Server state lives under `~/.t3` (e.g.
  `C:\Users\<name>\.t3`), and worktrees under `~/.t3/worktrees/<repo>/<branch>`.
  Keeping the root short preserves headroom for nested project paths. Avoid
  configuring a deeply-nested custom base dir on Windows.
- **git `core.longpaths`.** Every git invocation is run with
  `-c core.longpaths=true` on Windows (`applyWindowsGitLongPathArgs` in
  `apps/server/src/git/Layers/GitCore.ts`), so `git worktree add`, checkout, and
  status can handle >260-char paths without a global config change.
- **Temp paths.** Scratch directories use `os.tmpdir()`
  (`%LOCALAPPDATA%\Temp`), which is already short.

### Recommended machine setting

For full long-path support beyond git (e.g. tooling the app shells out to),
enable Windows long paths once per machine. This requires Windows 10 1607+:

- **Registry:** set
  `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled` (DWORD) to
  `1`, then reboot. PowerShell (admin):

  ```powershell
  New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
  ```

- **Group Policy:** _Computer Configuration → Administrative Templates → System →
  Filesystem → Enable Win32 long paths → Enabled._

This is a host prerequisite, not something the installer can set for the user
(it needs machine-level admin rights, which the per-user install intentionally
avoids).
