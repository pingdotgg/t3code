# Building and updating Kompas

Kompas is a fork of T3 Code. Its code lives in new files (`kompas` folders in the apps and the server, `packages/widgets`), with small hooks in T3 Code's own, so that upstream changes merge with few conflicts.

```sh
git fetch upstream
git merge upstream/main
vp i
vp run i18n:generate   # in apps/web, apps/mobile and apps/desktop
vp run check:changed
```

`gt generate` writes catalogs in a different order on Windows. Regenerate on Linux or macOS, or the diff touches every line.

## What differs from T3 Code

- Data folder: `~/.kompas` (dev: `~/.kompas/dev`). The installed T3 Code keeps `~/.t3`, so both can run on one computer.
- App ids `com.t3tools.kompas*`, link scheme `kompas://`, and its own background service.
- Desktop, server and phone look for releases in `slawk0/t3code`. Set `T3CODE_DESKTOP_UPDATE_REPOSITORY` when building to use another repository.
- Copy deep in the settings still says T3 Code. Changing it would change every translation key and conflict with each upstream change to it.

T3 Connect, push notifications and the hosted web app belong to T3 Code and are not set up here. Reach a computer from the phone over the local network or Tailscale; see [remote access](../user/remote-access.md).

## Desktop

```sh
T3CODE_DESKTOP_UPDATE_REPOSITORY=slawk0/t3code vp run dist:desktop:win   # or :dmg, :linux
```

The installer and `latest*.yml` land in `release/`. Publish both in one GitHub release whose tag is the version with a `v` in front; installed apps read `latest*.yml` from the newest release. Unsigned builds install with a warning on Windows and do not update themselves on macOS.

## Android

```sh
cd apps/mobile
APP_VARIANT=production EXPO_NO_GIT_STATUS=1 pnpm exec expo prebuild --platform android
cd android && ./gradlew :app:assembleRelease
```

The APK is in `android/app/build/outputs/apk/release`. It is signed with the debug key unless you configure one; keep using the same key, because Android refuses an update signed with another.

On Windows, the CMake that Gradle installs ships ninja 1.10, which cannot follow pnpm's long paths and ends with `manifest 'build.ninja' still dirty after 100 tries`. Replace `cmake/3.22.1/bin/ninja.exe` in the Android SDK with ninja 1.12 or newer, and turn on long paths in Windows.

Over-the-air updates are off unless `KOMPAS_EAS_PROJECT_ID` (and `KOMPAS_EXPO_OWNER`) name your own Expo project: T3 Code's updates would replace the app.

## Widgets

`packages/widgets` builds each widget into one self-contained page, because the frame that shows it loads nothing else. The web build copies them into the client the server serves; a dev server builds them on its first start, and `pnpm --filter @t3tools/widgets build` after a change.
