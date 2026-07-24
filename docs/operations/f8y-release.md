# f8y Continuous Releases

`.github/workflows/f8y-release.yml` publishes a GitHub prerelease for every push to `main` and can
also be started manually. A release is atomic: it is published only after all platform builds
succeed.

Each release contains seven assets:

- an ad-hoc-signed Apple Silicon (`arm64`) macOS DMG
- the DMG's SHA-256 checksum
- a signed Android APK named `T3-Code-<version>-android.apk`
- a self-contained, ad-hoc-signed Apple Silicon CLI named `t3-<version>-darwin-arm64`
- the macOS CLI's SHA-256 checksum
- a self-contained Linux x86_64 CLI named `t3-<version>-linux-x64`
- the Linux CLI's SHA-256 checksum

Versions preserve the numeric core of the checked-in desktop version and append the UTC date and
GitHub Actions run number, for example checked-in `0.0.28` produces
`0.0.28-f8y.20260720.42`. The complete derived version is shared by the Git tag and every release
artifact. Android uses the workflow run number as its monotonically increasing `versionCode`.

## Android signing setup

Android requires every installable APK to be signed. Successive APKs must use the same key to update
in place. Generate one long-lived RSA keystore with the fixed alias `t3code-f8y`:

```sh
keytool -genkeypair \
  -keystore t3code-f8y.jks \
  -alias t3code-f8y \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Configure these GitHub Actions repository secrets before the workflow first runs:

- `F8Y_ANDROID_KEYSTORE_BASE64`: the keystore encoded as one base64 string
- `F8Y_ANDROID_STORE_PASSWORD`: the keystore password
- `F8Y_ANDROID_KEY_PASSWORD`: the key password

On macOS, produce the first secret value with:

```sh
base64 -i t3code-f8y.jks | tr -d '\n'
```

Never commit the keystore. Losing it means existing installations cannot be updated by a newly keyed
APK; uninstall the old application before installing the replacement. Do not install an APK for
`com.f8y.t3code` from another signing source because Android will reject an update signed by a
different key.

## macOS integrity and Gatekeeper

The macOS app is ad-hoc signed because this release does not use a paid Apple Developer account.
Ad-hoc signing gives every nested executable a verifiable code signature, but it does not establish a
developer identity and cannot be notarized. Gatekeeper will therefore block the first launch of a
browser-downloaded build until the user explicitly allows it.

The workflow verifies the DMG filesystem, bundle ID, and nested code signatures before upload. It
also publishes `<DMG filename>.sha256`. Verify the download from a terminal opened in the download
directory:

```sh
shasum -a 256 -c T3-Code-*.dmg.sha256
```

After the checksum reports `OK`, open the DMG, drag the application to `/Applications`, and try to
launch it once. Then open **System Settings → Privacy & Security**, scroll to Security, and select
**Open Anyway**. macOS remembers this exception for that application. Do not bypass Gatekeeper if the
checksum does not match the file published with the same GitHub release.

## Obtainium setup

On the Android device:

1. Install Obtainium.
2. Add `https://github.com/totalolage/t3code` as a GitHub source.
3. Enable prereleases.
4. Disable **Verify Latest Tag** because f8y builds are prereleases and are never marked as the
   repository's latest stable release.
5. Sort releases by date.
6. Set **Filter APKs by Regular Expression** to `^T3-Code-.*-android\.apk$`.
7. Enable update notifications.
8. Allow Obtainium to install unknown applications when Android requests permission.

The repository is public, so a GitHub token is normally unnecessary for this single source. Add a
token in Obtainium only if GitHub API rate limits become a problem. See Obtainium's
[GitHub source documentation](https://wiki.obtainium.imranr.dev/sources/) for the source-specific
settings.

Obtainium detects and downloads new APKs, but a stock Android device still shows the system update
confirmation. After installation, application data is preserved because the package ID remains
`com.f8y.t3code`, the signing key stays constant, and each release has a higher `versionCode`.

## macOS installation and updates

The macOS build uses app ID `com.f8y.t3code` and intentionally contains no Electron update-feed
configuration. Install new versions manually from GitHub Releases. A normal warning-free first launch
is not possible without Developer ID signing and Apple notarization.

Native macOS passkeys are also unavailable in this account-free build because Associated Domains
requires an Apple-issued provisioning profile.

Automatic macOS updates additionally require publishing the Electron ZIP and channel metadata
alongside the DMG. The f8y workflow currently publishes only the manually installable DMG.

## Standalone CLI

The macOS arm64 and Linux x86_64 CLIs embed their JavaScript runtime and dependencies, so Node.js,
Bun, and a package manager are not required on the target machine. They contain the complete `t3`
command tree, including the server, service lifecycle, provider, and remote commands.

Download the binary for your platform and its adjacent `.sha256` file from the same f8y release,
then verify and install it.

On Apple Silicon macOS:

```sh
shasum -a 256 -c t3-*-darwin-arm64.sha256
chmod +x t3-*-darwin-arm64
mkdir -p "$HOME/.local/bin"
install -m 755 t3-*-darwin-arm64 "$HOME/.local/bin/t3"
t3 --version
t3 remote --help
```

The binary is ad-hoc signed, not Apple-notarized. If a browser marks it as quarantined, verify the
checksum first, then allow it using the same **System Settings → Privacy & Security** flow described
for the desktop app.

On Linux x86_64:

```sh
sha256sum -c t3-*-linux-x64.sha256
chmod +x t3-*-linux-x64
mkdir -p "$HOME/.local/bin"
install -m 755 t3-*-linux-x64 "$HOME/.local/bin/t3"
t3 --version
t3 remote --help
```

## Verification

For the first release:

1. Confirm the GitHub prerelease targets the expected `main` commit and contains one DMG, one APK,
   both CLI binaries, and all four checksums.
2. Install the APK through Obtainium.
3. Verify the installed package is `com.f8y.t3code` and its version matches the release.
4. Download the DMG and checksum in a browser and confirm `shasum -a 256 -c` reports `OK`.
5. Install the app on a separate Mac and confirm the documented **Open Anyway** flow works.
6. Publish a later `main` build and confirm Obtainium detects it.
7. Install the update without uninstalling and confirm settings and application data remain intact.
8. Install each CLI on Apple Silicon macOS and Linux x86_64 without Node.js or Bun and confirm
   `t3 remote --help` succeeds.

The workflow verifies the APK signature, package ID, version name, and version code before it uploads
the asset. Starting with the second release, it also compares the certificate and `versionCode` with
the previous f8y APK and rejects a changed key or non-increasing code.
