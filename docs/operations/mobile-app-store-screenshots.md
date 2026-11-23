# Mobile app-store screenshot harness

Captures store-ready iOS and Android screenshots by running the real mobile app (`EXPO_PUBLIC_SHOWCASE=1`) against three disposable local servers seeded with deterministic fixtures. Output lands under `artifacts/app-store/screenshots/`.

## Run locally

```sh
pnpm screenshots:mobile                                            # full dark matrix (t3-code)
pnpm screenshots:mobile --device iphone-6.9 --scene thread         # single device/scene
pnpm screenshots:mobile --appearance both --theme ocean            # appearance / palette overrides
pnpm screenshots:mobile --device ipad-13 --skip-build --keep-running
pnpm screenshots:mobile --list                                     # list devices, scenes, flags
pnpm screenshots:mobile --validate-only                            # validate existing PNGs only
```

- **Shared Metro port (`8199`):** Only run one harness at a time across worktrees. To reuse an external Metro process, run `APP_VARIANT=development EXPO_PUBLIC_SHOWCASE=1 pnpm exec expo start --dev-client --port 8199` in `apps/mobile` and pass `--skip-build --skip-metro`.
- **Prerequisites:**
  - iOS: Xcode CLI tools, CocoaPods, configured simulator runtimes, [AXe](https://github.com/cameroncooke/AXe) (`AXE_PATH` or `brew install axe`, used to lock simulator/handle permission prompts), and `agent-device` (`AGENT_DEVICE_PATH` or on `PATH`) for iPhone Duo fold pose.
  - Android: `ANDROID_HOME` / `ANDROID_SDK_ROOT` with `adb`, `emulator`, and the configured AVD.
- **Do not resize output manually:** The harness validates dimensions, 24-bit RGB without alpha, file size, and store counts; edit store specs and targets in [`scripts/mobile-showcase.config.ts`](../../scripts/mobile-showcase.config.ts) (seeded data lives in [`scripts/mobile-showcase-environment.ts`](../../scripts/mobile-showcase-environment.ts)).

## Run in GitHub Actions

Dispatch the **Mobile Showcase Screenshots** workflow (choose platform, appearance, and palette; `all` themes raises the job timeout). Partial PNGs still upload on failure for diagnosis; download `app-store-connect-screenshots` and `google-play-screenshots` from workflow artifacts.
