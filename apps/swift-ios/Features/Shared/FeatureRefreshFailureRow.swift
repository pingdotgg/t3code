import SwiftUI

struct FeatureRefreshFailureRow: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(T3Colors.warning)
            Text(message)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Retry", action: retry)
                .font(T3Typography.control.weight(.semibold))
        }
        .accessibilityElement(children: .contain)
    }
}
