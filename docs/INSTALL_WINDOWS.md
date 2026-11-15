# Install Continuum IDE on Windows

Supported: Windows 10 (version 1809 or newer) and Windows 11, 64-bit (x64).

## Install

1. Open the [Releases page](https://github.com/SwashX-dev/continuum-ide/releases/latest).
2. Download `Continuum-IDE-Setup-x64.exe`.
3. Run it. If **Windows protected your PC** appears, choose **More info → Run anyway**.
   The installer is not code-signed, so SmartScreen does not recognize the publisher yet.
4. The installer creates Start-menu and desktop shortcuts and launches Continuum IDE.

To check that the download is intact, compare its hash with the `SHA256SUMS` file on the release:

```powershell
Get-FileHash .\Continuum-IDE-Setup-x64.exe -Algorithm SHA256
```

## Where your data lives

| What                          | Location                                 |
| ----------------------------- | ---------------------------------------- |
| Conversations, settings, logs | `%USERPROFILE%\.continuum\`              |
| Browser profile (in-app)      | `%APPDATA%\continuum-ide\`               |
| Program files                 | `%LOCALAPPDATA%\Programs\Continuum IDE\` |

Updating or reinstalling never touches `%USERPROFILE%\.continuum`.

## Agents on Windows

Install agent CLIs the way their vendors document for Windows (for example Claude Code's native
installer, or `npm install -g @openai/codex`). If an agent is not detected, set its full path in
**Settings → Providers → Binary path** (for example `C:\Users\you\AppData\Roaming\npm\codex.cmd`).

### WSL

To run agents inside WSL, open **Settings → Connections** and turn on the WSL backend, then pick a
distribution. Projects inside WSL then open with Linux paths.

## Uninstall

Settings → Apps → Installed apps → **Continuum IDE** → Uninstall. Delete
`%USERPROFILE%\.continuum` as well to remove all conversations and settings.

## Known limitations

- The installer is unsigned (see above).
- Windows ARM64 has no prebuilt installer yet; build from source.
- The Windows installer is built and checked in CI; hands-on testing on real Windows machines is
  still limited. Please report problems on the
  [issue tracker](https://github.com/SwashX-dev/continuum-ide/issues).
