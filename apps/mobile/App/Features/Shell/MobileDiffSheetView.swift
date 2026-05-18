import SwiftUI
import T3MobileProtocol

struct MobileDiffSheetView: View {
    let diff: MobileTurnDiff

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(diff.diff.isEmpty ? "No diff available." : diff.diff)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .accessibilityLabel(diff.diff.isEmpty ? "No diff available." : "Diff text")
            }
            .navigationTitle("Diff")
        }
    }
}
