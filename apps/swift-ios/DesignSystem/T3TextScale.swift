import SwiftUI
import UIKit

enum T3TextSizing {
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

    static func contentSizeCategory(
        system: UIContentSizeCategory,
        steps: Int
    ) -> UIContentSizeCategory {
        guard steps != 0, let index = categories.firstIndex(of: system) else { return system }
        return categories[min(categories.count - 1, max(0, index + steps))]
    }
}

extension DynamicTypeSize {
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
    var t3CodeSizeSteps: Int {
        get { self[T3CodeSizeStepsKey.self] }
        set { self[T3CodeSizeStepsKey.self] = newValue }
    }
}

extension View {
    func t3AppTextSize(steps: Int) -> some View {
        modifier(T3AppTextSize(steps: steps))
    }

    func t3CodeSizing(steps: Int) -> some View {
        environment(\.t3CodeSizeSteps, steps)
    }

    func t3CodeTextSize(_ isEnabled: Bool = true) -> some View {
        modifier(T3CodeTextSize(isEnabled: isEnabled))
    }
}

/// Uses the window trait so the preference reaches sheets and UIKit-hosted cells.
/// Removing the override at zero preserves the reader's system Dynamic Type setting.
private struct T3AppTextSize: ViewModifier {
    let steps: Int
    @State private var systemCategory = UIApplication.shared.preferredContentSizeCategory

    func body(content: Content) -> some View {
        content
            .onAppear { apply() }
            .onChange(of: steps) { _, _ in apply() }
            .task {
                for await change in NotificationCenter.default.notifications(
                    named: UIContentSizeCategory.didChangeNotification
                ) {
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
        content.dynamicTypeSize(dynamicTypeSize.t3Shifted(by: isEnabled ? codeSteps : 0))
    }
}
