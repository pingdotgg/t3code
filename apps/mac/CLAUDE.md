# apps/mac — agent rules

Native SwiftUI macOS app (macOS 26+ Liquid Glass). Read ARCHITECTURE.md first.

Hard rules (build breaks otherwise — no Xcode on this machine, CLT only):

- NEVER use `@State`, `@Entry`, or `@Animatable` — the macOS 27 beta SDK makes
  them Xcode-only compiler macros. Use `@UIState`
  (Sources/SergeCodeMac/Support/StateShim.swift), manual `EnvironmentKey`
  conformances, and manual `Animatable` conformance instead.
- `@Observable`, `@Binding`, `@Environment`, `@Bindable`, `@StateObject` are fine.
- Build/test: `swift build --package-path apps/mac`. Tests need the swift-testing
  macro plugin passed explicitly (CLT keeps it in a subdir the compiler doesn't
  search) AND two runtime rpaths (Testing.framework + lib*TestingInterop live
  outside dyld's default search; DYLD*\* env is stripped from the Apple-signed
  test helper, so they must be linked in):
  `swift test --package-path apps/mac -Xswiftc -plugin-path -Xswiftc
/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing
-Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks
-Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib`.
  App bundle: `apps/mac/scripts/make-app.sh`.
- Live E2E (spawns real server): prefix with `SERGECODE_LIVE_E2E=1`, filter
  `LiveIntegrationTests`.
- Concurrency: Swift 6 strict mode. UI types `@MainActor`; T3Kit/SidecarKit
  internals actor-isolated.
- Do not edit Package.swift without coordinating — target layout is fixed
  (T3Kit, SidecarKit, SergeCodeMac + test targets).
- Liquid Glass: glass for chrome (toolbars, composer, sheets); never behind
  long-form text (chat bodies, diffs).

## Versioning and Sparkle Releases

Before changing `version.json`, tagging, generating an appcast entry, or
starting a release, ask the user and wait for an explicit choice:

> Should this work create a new app version/release, or should it be added to
> the current rolling/pending version number?

For rolling/pending work, preserve both `version` and `buildNumber` and do not
create release artifacts. For a new release, use the user's requested semver
bump and increase `buildNumber` monotonically. `version.json` is the source of
truth; `sync-version.sh` maps it to `CFBundleShortVersionString` and
`CFBundleVersion`. Sparkle orders updates by the numeric build number, while
the semver value is display text.

The normal release path is: version change in a PR to `main`, merge it, run
`Release macOS App` manually from merged `main`, then review and merge the
automatically opened appcast PR. Do not use `version-bump.sh` during ordinary
PR work because it commits and tags immediately; use it only when the user
explicitly requests that behavior. All GitHub operations must target
`SergeSerb2/SergeCode`.
