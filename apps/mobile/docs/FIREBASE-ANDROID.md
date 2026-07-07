# Firebase / FCM — Android dev client

FCM push tokens require a **custom dev client** — not Expo Go.

## Human setup (before GATE-M0 / step s09)

1. Firebase Console → project for T3 Code mobile
2. Add Android app: package `com.t3tools.t3code.dev` (development variant)
3. Download `google-services.json`
4. EAS: `eas secret:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json`
5. Rebuild:

```bash
cd apps/mobile
vp run android:dev
```

6. Install APK on physical device for push testing.

## Agent wiring (step s08)

- `app.config.ts` — Expo config plugin for `@react-native-firebase/app` or official Expo Firebase pattern per SDK 52 docs
- Never commit `google-services.json` to git

## Verify

```bash
# After sign-in on device, registration logs should show token.type === "android"
# See remoteRegistration.test.ts
```
