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
7. Sets the requested system appearance and normalizes status bars, converts captures to 24-bit RGB PNGs without alpha, and
   validates dimensions, aspect ratio, file size, and screenshot count before succeeding.
8. Writes store-ready folders beneath `artifacts/app-store/screenshots/` that can be uploaded
   directly to App Store Connect or Google Play Console.

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

| Output folder                         | Capture target            | Upload dimensions | Store slot                                |
| ------------------------------------- | ------------------------- | ----------------- | ----------------------------------------- |
| `apple/iphone-6.9/{light,dark}/`      | iPhone 17 Pro Max         | 1320×2868         | App Store Connect iPhone 6.9-inch         |
| `apple/iphone-6.5/{light,dark}/`      | disposable iPhone 14 Plus | 1284×2778         | App Store Connect iPhone 6.5-inch         |
| `apple/ipad-13/{light,dark}/`         | iPad Pro 13-inch (M5)     | 2064×2752         | App Store Connect iPad 13-inch            |
| `google-play/phone/{light,dark}/`     | Pixel AVD at 420 dpi      | 1080×1920         | Google Play phone, portrait 9:16          |
| `google-play/tablet-7/{light,dark}/`  | Pixel AVD at 600dp width  | 1080×1920         | Google Play 7-inch tablet, portrait 9:16  |
| `google-play/tablet-10/{light,dark}/` | Pixel AVD at 800dp width  | 1440×2560         | Google Play 10-inch tablet, portrait 9:16 |

Each target captures thread, terminal, review, thread list, and environments, producing 30 PNG
files for one appearance or 60 for both. Each appearance folder's five screenshots satisfy the configured Apple limit of 1–10, Google
phone requirement of 2–8, and Google tablet recommendation/slot minimum of 4 with a maximum of 8.

The generated tree is deliberately aligned with the store upload fields:

    artifacts/app-store/screenshots/
    ├── apple/
    │   ├── iphone-6.9/{light,dark}/{thread,terminal,review,threads,environments}.png
    │   ├── iphone-6.5/{light,dark}/{thread,terminal,review,threads,environments}.png
    │   └── ipad-13/{light,dark}/{thread,terminal,review,threads,environments}.png
    └── google-play/
        ├── phone/{light,dark}/{thread,terminal,review,threads,environments}.png
        ├── tablet-7/{light,dark}/{thread,terminal,review,threads,environments}.png
        └── tablet-10/{light,dark}/{thread,terminal,review,threads,environments}.png

Edit [mobile-showcase.config.ts](../../scripts/mobile-showcase.config.ts) to change simulator or AVD
names, light/dark appearance, scenes, output directory, capture delay, Android ABI, or viewport.

## Capture in GitHub Actions

Run the `Mobile Showcase Screenshots` workflow from GitHub's Actions tab, choose `all`, `ios`, or
`android`, and select `light`, `dark`, or `both`. The default dispatch captures both appearances and
runs iOS and Android concurrently: iPhone and iPad capture on a
12-vCPU Blacksmith macOS runner, while Android phone, 7-inch tablet, and 10-inch tablet capture on a
16-vCPU Blacksmith Linux runner with a KVM-accelerated x86_64 emulator.

Every job uploads its PNGs even when a later capture fails, which makes partial runs useful for
diagnosis. Download `app-store-connect-screenshots` and `google-play-screenshots` from the workflow
run's Artifacts section. Each job runs validation again immediately before upload. Artifacts are
retained for 14 days.

The workflow uses the same checked-in device and scene matrix as local capture. Android remains
ARM64 by default for local Apple Silicon development; CI sets `T3_SHOWCASE_ANDROID_ABI=x86_64` so the
debug APK matches its accelerated emulator.

## Fast iteration

Capture one scene or device:

    pnpm screenshots:mobile --device iphone-6.9 --scene thread
    pnpm screenshots:mobile --platform android --scene review

Override the configured appearance or capture both variants:

    pnpm screenshots:mobile --appearance light
    pnpm screenshots:mobile --appearance dark
    pnpm screenshots:mobile --appearance both

Reuse the native build and retain the disposable environment:

    pnpm screenshots:mobile --device ipad-13 --skip-build --keep-running

Run Metro separately:

    pnpm --filter @t3tools/mobile showcase
    pnpm screenshots:mobile --skip-build --skip-metro --device iphone-6.9

List the matrix and flags:

    pnpm screenshots:mobile --list

Validate existing files without starting Metro, servers, simulators, or emulators:

    pnpm screenshots:mobile --validate-only
    pnpm screenshots:mobile --platform ios --validate-only

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

The Environments capture presents the three local fixture transports as a Tailscale HTTPS hostname,
a Helsinki VPS hostname, and a Tailnet IPv4 address. This display-only substitution keeps the cards
remote-first while the harness retains reliable loopback connections to its ephemeral servers.

## Local prerequisites

- iOS: Xcode command-line tools, the configured simulator runtimes, and installed CocoaPods.
- Android: ANDROID_HOME (or the default macOS SDK path), adb, emulator, and the configured AVD.

The harness is the source of truth for upload dimensions; do not resize its output. If store rules
change, update the target's `storeAsset` specification. Capture fails when a PNG is the wrong size,
has alpha, is not 8-bit RGB, exceeds the configured file-size limit, violates Google Play's 9:16
shape/bounds, or leaves a full output set below its store minimum.
