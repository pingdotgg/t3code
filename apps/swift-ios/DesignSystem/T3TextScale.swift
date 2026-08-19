import SwiftUI
import UIKit

/// Text sizing for the whole app.
///
/// Every `T3Typography` role is a semantic font, so the reader's system Dynamic
/// Type size already drives it. The size preferences here never replace that
/// baseline: they shift it by whole Dynamic Type steps and clamp at the ends of
/// the scale, so the app renders only sizes iOS itself supports and Settings ›
/// Display & Brightness — including the Accessibility sizes — keeps working.
enum T3TextSizing {
    /// The Dynamic Type ladder in UIKit terms, in the same order as
    /// `DynamicTypeSize.allCases`.
    private static let categories: [UIContentSizeCategory] = [
        .extraSmall,
        .small,
        .medium,
        .large,
        .extraLarge,
        .extraExtraLarge,
        .extraExtraExtraLarge,
        .accessibilityMedium,
        .accessibilityLarge,
        .accessibilityExtraLarge,
        .accessibilityExtraExtraLarge,
        .accessibilityExtraExtraExtraLarge,
    ]

    /// The category the app renders at: the reader's system category moved
    /// `steps` positions, saturating at both ends rather than wrapping. An
    /// unrecognised category (a future addition) is returned unchanged.
    static func contentSizeCategory(
        system: UIContentSizeCategory,
        steps: Int
    ) -> UIContentSizeCategory {
        guard steps != 0, let index = categories.firstIndex(of: system) else { return system }
        return categories[min(categories.count - 1, max(0, index + steps))]
    }
}

extension DynamicTypeSize {
    /// Moves `steps` positions along the Dynamic Type scale, saturating at both
    /// ends rather than wrapping.
    func t3Shifted(by steps: Int) -> DynamicTypeSize {
        guard steps != 0 else { return self }
        let sizes = DynamicTypeSize.allCases
        guard let index = sizes.firstIndex(of: self) else { return self }
        return sizes[min(sizes.count - 1, max(0, index + steps))]
    }
}

private struct T3CodeSizeStepsKey: EnvironmentKey {
    static let defaultValue = 0
}

extension EnvironmentValues {
    /// Extra Dynamic Type steps that monospaced surfaces add on top of the app
    /// text size. Read it through `t3CodeTextSize()` instead of directly, so
    /// every code surface resolves the preference the same way.
    var t3CodeSizeSteps: Int {
        get { self[T3CodeSizeStepsKey.self] }
        set { self[T3CodeSizeStepsKey.self] = newValue }
    }
}

extension View {
    /// Applies the app text size preference. Belongs at the app root.
    func t3AppTextSize(steps: Int) -> some View {
        modifier(T3AppTextSize(steps: steps))
    }

    /// Publishes the code size preference to the surfaces below. Idempotent —
    /// it sets a value rather than shifting one — so it is safe to repeat at a
    /// presentation root that the app-root value does not reach.
    func t3CodeSizing(steps: Int) -> some View {
        environment(\.t3CodeSizeSteps, steps)
    }

    /// Sizes a monospaced surface — a code block, a diff, tool output — with the
    /// code preference layered on the app text size. Apply it to leaves: two
    /// nested applications would count the preference twice. Pass `false` where
    /// the same view is only sometimes code.
    func t3CodeTextSize(_ isEnabled: Bool = true) -> some View {
        modifier(T3CodeTextSize(isEnabled: isEnabled))
    }
}

/// Applies the app text size by overriding the window's content size category
/// rather than writing SwiftUI's `dynamicTypeSize` environment value.
///
/// A window trait crosses the two boundaries that environment value cannot.
/// Sheets and full-screen covers are hosted outside the presenting view's
/// environment and resolve Dynamic Type from the window instead, and
/// UIKit-hosted cells resolve their fonts from the trait collection — both
/// ignore `dynamicTypeSize` written further up the SwiftUI tree. Overriding the
/// window is also how iOS's own per-app text size works.
private struct T3AppTextSize: ViewModifier {
    let steps: Int

    /// The reader's own setting, kept separate from the override so the
    /// preference always composes with it instead of replacing it.
    @State private var systemCategory = UIApplication.shared.preferredContentSizeCategory

    func body(content: Content) -> some View {
        content
            .onAppear { apply() }
            .onChange(of: steps) { _, _ in apply() }
            .task {
                let changes = NotificationCenter.default.notifications(
                    named: UIContentSizeCategory.didChangeNotification
                )
                for await change in changes {
                    systemCategory = change.userInfo?[
                        UIContentSizeCategory.newValueUserInfoKey
                    ] as? UIContentSizeCategory
                        ?? UIApplication.shared.preferredContentSizeCategory
                    apply()
                }
            }
    }

    @MainActor
    private func apply() {
        let category = T3TextSizing.contentSizeCategory(system: systemCategory, steps: steps)
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        for window in windows {
            // At the default the app should be indistinguishable from one with
            // no preference at all, so drop the override rather than pin it.
            if steps == 0 {
                window.traitOverrides.remove(UITraitPreferredContentSizeCategory.self)
            } else {
                window.traitOverrides.preferredContentSizeCategory = category
            }
        }
    }
}

private struct T3CodeTextSize: ViewModifier {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @SwiftUI.Environment(\.t3CodeSizeSteps) private var codeSteps
    let isEnabled: Bool

    func body(content: Content) -> some View {
        content.dynamicTypeSize(
            dynamicTypeSize.t3Shifted(by: isEnabled ? codeSteps : 0)
        )
    }
}
