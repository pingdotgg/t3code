# Mobile app-store screenshot harness

The screenshot harness runs the real mobile application against three disposable local T3
environments. It creates an isolated base directory and server for each environment, real Git
projects with deterministic content, seeded orchestration projections, and persisted terminal
history. The app pairs with every server through its normal connection flow and React Navigation
opens the production Home, Thread, ThreadTerminal, ThreadReview, and SettingsEnvironments routes.

No screenshot-specific screen recreates application UI. `EXPO_PUBLIC_SHOWCASE=1` only enables the
non-rendering pairing/readiness coordinator, disables terminal autofocus so captures do not contain
the software keyboard, and supplies deterministic T3 Connect discovery rows to the real
Environments screen. The local environment cards always come from real paired servers.

## Capture the default matrix

From the repository root:

    pnpm screenshots:mobile

The command:

1. Creates three temporary T3 base directories and starts a local server for each on an available
   port.
2. Creates T3 Code, React, and Linux Git repositories with recognizable favicons, feature branches,
   and a deterministic T3 Code review diff.
3. Seeds each server's migrated SQLite database with playful threads, messages, activities, and
   terminal history, then adds two persisted mobile-outbox tasks waiting to send.
4. Starts an isolated Metro server, builds the selected native apps, and boots each device.
5. Pairs each clean app installation with Moonbase Terminal, Suspense Station, and Kernel Cabin.
6. Navigates to the real application route for every requested scene.
7. Normalizes appearance and status bars and writes exact-size PNGs to
   artifacts/app-store/screenshots/.

The servers, Metro, temporary root directory, and devices started by the runner are cleaned up after
capture. Pass `--keep-running` to retain them for inspection; the runner prints the base-directory
paths and server ports.

Captures wait for the real environment snapshot to hydrate and for the requested route to become
active. Both platforms record readiness in the simulator/emulator app container. A final settle
delay allows native terminal and Git review data to finish rendering.

A full capture regenerates the selected native project with Expo's clean development prebuild before
building it. Use --skip-build for repeated captures after the first build.

The harness uses its own Metro port (8199 by default), so an ordinary mobile server or another
worktree cannot accidentally provide the bundle being photographed.

The default matrix is:

- iphone-6.9: iPhone 17 Pro Max
- ipad-13: iPad Pro 13-inch (M5)
- pixel: Pixel 10 Pro Android AVD
- android-tablet: Pixel Android AVD rendered at an 800dp tablet viewport

Each device captures the thread, terminal, review, thread list, and environments scenes, for 20
PNG files in the complete matrix.

Edit [mobile-showcase.config.ts](../../scripts/mobile-showcase.config.ts) to change simulator or AVD
names, light/dark appearance, scenes, output directory, capture delay, Android ABI, or viewport.

## Capture in GitHub Actions

Run the `Mobile Showcase Screenshots` workflow from GitHub's Actions tab and choose `all`, `ios`, or
`android`. The default `all` dispatch runs iOS and Android concurrently: iPhone and iPad capture on a
12-vCPU Blacksmith macOS runner, while Pixel phone and tablet capture on a 16-vCPU Blacksmith Linux
runner with a KVM-accelerated x86_64 emulator.

Every job uploads its PNGs even when a later capture fails, which makes partial runs useful for
diagnosis. Download `app-store-screenshots-ios` and `app-store-screenshots-android` from the workflow
run's Artifacts section. Artifacts are retained for 14 days.

The workflow uses the same checked-in device and scene matrix as local capture. Android remains
ARM64 by default for local Apple Silicon development; CI sets `T3_SHOWCASE_ANDROID_ABI=x86_64` so the
debug APK matches its accelerated emulator.

## Fast iteration

Capture one scene or device:

    pnpm screenshots:mobile --device iphone-6.9 --scene thread
    pnpm screenshots:mobile --platform android --scene review

Reuse the native build and retain the disposable environment:

    pnpm screenshots:mobile --device ipad-13 --skip-build --keep-running

Run Metro separately:

    pnpm --filter @t3tools/mobile showcase
    pnpm screenshots:mobile --skip-build --skip-metro --device iphone-6.9

List the matrix and flags:

    pnpm screenshots:mobile --list

## Customize the seeded environment

- Project repository, thread projections, conversation, terminal transcript, and Git changes:
  [mobile-showcase-environment.ts](../../scripts/mobile-showcase-environment.ts)
- Device and capture matrix:
  [mobile-showcase.config.ts](../../scripts/mobile-showcase.config.ts)
- Simulator/emulator orchestration:
  [mobile-showcase.ts](../../scripts/mobile-showcase.ts)

Fixture timestamps are generated relative to capture startup so every route shows stable relative
labels while the server still receives valid current data. The same deterministic three-environment
ensemble serves iPhone, iPad, Android phone, and Android tablet captures; responsive differences
come entirely from the production app layout.

The Pending rows use the production offline outbox and point at the real T3 Code and React fixture
projects. Showcase coordination holds those two entries in the outbox for capture, just like a task
currently open for editing, so reconnecting the seeded environments cannot deliver and remove them
before the screenshot is taken.

## Local prerequisites

- iOS: Xcode command-line tools, the configured simulator runtimes, and installed CocoaPods.
- Android: ANDROID_HOME (or the default macOS SDK path), adb, emulator, and the configured AVD.

For store submission, keep generated PNGs unscaled. Configure device classes and Android viewport
dimensions that match the exact upload slots.
