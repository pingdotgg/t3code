# Android notifications

The Android app receives Firebase Cloud Messaging (FCM) data messages. Either a paired environment or T3 Connect sends them directly through FCM HTTP v1; an Expo Push account is not required.

## Self-hosted paired delivery

Direct/Tailscale-paired Android clients can receive completion, failure, approval and input alerts without Clerk, T3 Connect or a separate watcher. Each server needs the Firebase service-account JSON in `T3CODE_FCM_SERVICE_ACCOUNT`; each APK needs a Google services file from the same Firebase project. Use a service account with the **Firebase Cloud Messaging API Admin** role (`roles/firebasecloudmessaging.admin`) on that project, and enable the Firebase Cloud Messaging API.

Add these values to the fnox `local` profile using your existing encrypted provider:

```sh
fnox set --profile local --provider <your-age-provider> T3CODE_FCM_SERVICE_ACCOUNT < /private/path/service-account.json
fnox set --profile local --provider <your-age-provider> T3CODE_ANDROID_GOOGLE_SERVICES_FILE < /private/path/google-services.json
```

Both entries store the JSON contents, not a machine-specific file path. Set `as_file = true` on the `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` entry in `fnox.toml` (already configured for this fork). Under `fnox exec`, the service-account variable contains JSON while the Google services variable points to a permission-restricted temporary file that fnox removes when the command exits. Keep prebuild and the native build inside that command; do not persist its temporary path for a later build. Keep any source copies outside the repository. The Google services file must contain the chosen APK package identifier; it does not contain the service-account private key.

Run the server under `fnox exec --profile local --no-defaults -- <server-command>`. For SSH-managed servers, configure fnox and resolve the service-account variable **on the remote host when its launcher starts**; setting it only on the desktop does not forward it to SSH. Restart the server after changing the credentials. This capability is disabled when the variable is absent or the JSON is malformed. Existing T3 Connect credentials and delivery are unaffected.

For Finder/Dock launches on macOS, the desktop can read the same service-account JSON from a login Keychain generic-password item with service **T3 Code paired notifications** and account **T3CODE_FCM_SERVICE_ACCOUNT**. Store the existing JSON there once; do not put it in the app bundle or a global launchctl environment variable. The desktop loads it before starting its local server, and an inherited nonempty environment variable takes precedence. Keychain may request permission on first access. Missing credentials leave paired delivery disabled; denied access logs a warning without credential contents and does not prevent the app from opening. This fallback does not configure SSH servers or other clients.

Build a new Android APK under the same fnox profile with `T3CODE_MOBILE_UPDATES_ENABLED=0` for a private binary; preserve its existing package identifier and [private signing identity](#private-fork-apk-signing). No Clerk or relay configuration is needed for paired delivery. On the phone, pair normally, then enable the environment under **Settings → Notifications → Paired environments**.

Paired delivery reuses T3 Connect's alert selection, activity aggregation and Android renderer. Rich payloads include thread/project titles, status and thread routes, but not conversations, code, files or credentials. They are encrypted with P-256 ECDH, HKDF-SHA256 and AES-256-GCM before FCM receives them. The phone creates a separate key per registration; only its public key is uploaded through the authenticated pairing connection. Its private key remains native and is wrapped by Android Keystore so process-exited delivery can decrypt without JavaScript. The versioned envelope binds the registration and message ID to the authenticated ciphertext. Google sees opaque IDs, encrypted content, the FCM token, Android package identifier and delivery metadata; encryption is not a compliance guarantee.

The server must stay running with outbound Google access. Receiving an alert does not require Tailscale or a live phone-to-server connection; opening its thread does. Registrations belong to existing client sessions, and delivery rechecks authorization, expiry, opt-out and current thread state. The existing private file store retains delivered baselines and pending delivery across restarts; failed sends retry every 30 seconds for up to five minutes. Registration replay silently restores activity, rather than announcing old work. Native alert deduplication and per-source ordering prevent retries from buzzing twice or rolling back activity. Already handed-off FCM messages cannot be recalled by server-side revocation.

Upgrade both the server and the Android binary for encrypted delivery. The app automatically refreshes enabled registrations; the server refuses keyless registrations and never falls back to rich plaintext. Legacy generic messages and their opaque tap references remain readable during the upgrade. No Firebase credential change is needed. Activity snapshots from independently paired environments are merged on the phone, and disabling one environment removes only its alerts, activity and key. Connect sign-out does not remove paired subscriptions. Enable/disable the existing ongoing activity preference under **Paired environments**, without signing in to Connect.

Test a locked/backgrounded phone, a process-exited phone, a cold-start tap, foreground thread suppression, multiple environments, dismissal, opt-out while offline, token rotation and pairing revocation before relying on it. Android **Force stop** prevents delivery until the app is reopened. Paired iOS push is not supported.

### Private fork APK signing

The repository's fnox `local` profile stores a private Android signing key using Nicholas's user-level age provider. After building a bundled release APK, sign it with the same key for every update:

```sh
APKSIGNER="$ANDROID_HOME/build-tools/<version>/apksigner" \
fnox exec --profile local --no-defaults -- \
  bash scripts/sign-android-apk.sh \
  apps/mobile/android/app/build/outputs/apk/release/app-release.apk \
  release/t3-code-preview.apk
```

Run this from the repository root with a JDK available. The script resolves passwords from the environment, restores the keystore only in a permission-restricted temporary directory, and removes it after signing. Updates retain app-local data only when the application ID and signing key match and the version code does not decrease. This key cannot update a Play Store installation or an earlier debug-signed APK; do not replace it after installing a private build.
