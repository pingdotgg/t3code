# apps/mac — agent rules

Native SwiftUI macOS app (macOS 26+ Liquid Glass). Read ARCHITECTURE.md first.

Hard rules (build breaks otherwise — no Xcode on this machine, CLT only):
- NEVER use `@State`, `@Entry`, or `@Animatable` — the macOS 27 beta SDK makes
  them Xcode-only compiler macros. Use `@UIState`
  (Sources/SergeCodeMac/Support/StateShim.swift), manual `EnvironmentKey`
  conformances, and manual `Animatable` conformance instead.
- `@Observable`, `@Binding`, `@Environment`, `@Bindable`, `@StateObject` are fine.
- Build/test: `swift build --package-path apps/mac` and
  `swift test --package-path apps/mac`. App bundle: `apps/mac/scripts/make-app.sh`.
- Concurrency: Swift 6 strict mode. UI types `@MainActor`; T3Kit/SidecarKit
  internals actor-isolated.
- Do not edit Package.swift without coordinating — target layout is fixed
  (T3Kit, SidecarKit, SergeCodeMac + test targets).
- Liquid Glass: glass for chrome (toolbars, composer, sheets); never behind
  long-form text (chat bodies, diffs).
