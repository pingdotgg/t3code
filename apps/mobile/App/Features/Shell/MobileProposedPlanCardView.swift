import SwiftUI

struct MobileProposedPlanCardView: View {
    let plan: MobileProposedPlan
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(plan.implementedAt == nil ? "Proposed Plan" : "Implemented Plan", systemImage: "list.bullet.clipboard")
                .font(.headline)
            Text(plan.markdown)
                .font(.callout)
                .textSelection(.enabled)
                .lineLimit(isExpanded ? nil : 12)
            if plan.markdown.split(separator: "\n", omittingEmptySubsequences: false).count > 12 || plan.markdown.count > 900 {
                Button(isExpanded ? "Show Less" : "Show More") {
                    isExpanded.toggle()
                }
                .font(.caption.weight(.semibold))
            }
            if let implementedAt = plan.implementedAt {
                Text("Implemented \(implementedAt)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground).opacity(0.9), in: RoundedRectangle(cornerRadius: MobileDesign.cornerRadius))
        .accessibilityElement(children: .contain)
    }
}
