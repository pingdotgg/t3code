import SwiftUI

struct MobileCheckpointCardView: View {
    let checkpoint: MobileCheckpointSummary
    let onShowDiff: (MobileCheckpointSummary) -> Void
    let onRevert: (MobileCheckpointSummary) -> Void
    @State private var confirmsRevert = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Checkpoint \(checkpoint.turnCount)", systemImage: "arrow.triangle.branch")
                    .font(.headline)
                Spacer()
                Text(checkpoint.status)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            if !checkpoint.files.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(checkpoint.files.prefix(4)) { file in
                        HStack {
                            Text(file.path)
                                .lineLimit(1)
                            Spacer()
                            Text("+\(file.additions) -\(file.deletions)")
                                .foregroundStyle(.secondary)
                        }
                        .font(.caption)
                    }
                    let remainingFileCount = checkpoint.files.count - 4
                    if remainingFileCount > 0 {
                        Text("and \(remainingFileCount) more")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            HStack {
                Button("Show Diff") {
                    onShowDiff(checkpoint)
                }
                .buttonStyle(.bordered)
                Button("Revert") {
                    confirmsRevert = true
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .background(Color(.tertiarySystemBackground).opacity(0.9), in: RoundedRectangle(cornerRadius: MobileDesign.cornerRadius))
        .accessibilityElement(children: .contain)
        .confirmationDialog(
            "Revert to checkpoint \(checkpoint.turnCount)?",
            isPresented: $confirmsRevert,
            titleVisibility: .visible
        ) {
            Button("Revert", role: .destructive) {
                onRevert(checkpoint)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This asks the server to roll the thread's workspace back to this checkpoint.")
        }
    }
}
