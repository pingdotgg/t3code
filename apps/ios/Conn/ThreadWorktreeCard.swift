import SwiftUI

struct ThreadWorktreeCard: View {
    let setup: FfiWorktreeSetup
    @Environment(\.connTheme) private var theme

    var body: some View {
        ThreadCard {
            Label("Worktree setup", systemImage: "arrow.triangle.branch")
            Spacer()
            statusIcon(setup.phase, progress: completedFraction)
            if let elapsed = threadElapsed(setup.startedAt, setup.endedAt) { Text(elapsed) }
        } content: {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(setup.stages.filter { $0.status != "skipped" }, id: \.id) { stage in
                    HStack {
                        statusIcon(stage.status)
                        Text(stageLabel(stage))
                        Spacer()
                        if let elapsed = threadElapsed(stage.startedAt, stage.endedAt) { Text(elapsed).foregroundStyle(theme.mutedForeground) }
                    }
                }
                if let error = setup.error { Text(error).foregroundStyle(theme.destructive).textSelection(.enabled) }
            }.padding(11).font(.system(size: 13))
        }
    }

    private func stageLabel(_ stage: FfiSetupStage) -> String {
        if let detail = stage.detail, !detail.isEmpty { return detail }
        switch (stage.id, stage.status) {
        case ("checkout", "done"): return "Created worktree"
        case ("setup-script", "done"): return "Ran setup script"
        case ("setup-script", "failed"): return "Setup script failed"
        case ("setup-script", "running"): return "Running setup script"
        default: return ["fetch":"Fetch repository", "checkout":"Create worktree", "submodules":"Update submodules",
                         "setup-script":"Setup script", "agent":"Start agent"][stage.id] ?? stage.id
        }
    }

    private var completedFraction: CGFloat? {
        let stages = setup.stages.filter { $0.status != "skipped" }
        guard !stages.isEmpty else { return nil }
        let completed = stages.filter { $0.status == "done" || $0.status == "warning" }
        return CGFloat(completed.count) / CGFloat(stages.count)
    }

    @ViewBuilder
    private func statusIcon(_ status: String, progress: CGFloat? = nil) -> some View {
        if status == "running", let progress {
            ZStack {
                Circle().stroke(theme.mutedForeground.opacity(0.35), lineWidth: 2)
                Circle().trim(from: 0, to: progress)
                    .stroke(theme.mutedForeground, lineWidth: 2)
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 14, height: 14)
            .accessibilityLabel("Running")
            .accessibilityValue(Double(progress).formatted(.percent))
        } else if status == "running" {
            ProgressView().controlSize(.mini).tint(theme.mutedForeground)
                .accessibilityLabel("Running")
        } else {
            Image(systemName: ["done": "checkmark", "failed": "xmark", "cancelled": "minus.circle",
                               "warning": "exclamationmark.triangle"][status] ?? "circle")
                .foregroundStyle(status == "failed" ? theme.destructive : theme.mutedForeground)
                .accessibilityLabel(status.capitalized)
        }
    }
}
