import SwiftUI

struct FeatureThreadAgentsView: View {
    let roster: FeatureThreadAgentRoster?
    let onOpenThread: @MainActor (String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let roster, !roster.agents.isEmpty {
                    ForEach(roster.agents) { agent in
                        FeatureThreadAgentRow(agent: agent, onOpenThread: onOpenThread)
                        Divider().overlay(Color.white.opacity(0.18))
                    }
                } else {
                    Text("No agents in this turn.")
                        .font(T3Typography.supporting)
                        .padding(.vertical, 16)
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 16)
        }
        .background(Color.black)
        .foregroundStyle(Color.white)
        .tint(.white)
        .buttonStyle(.plain)
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
    }
}

/// Shared by the roster and transcript. Only children with a real thread ID are links.
struct FeatureThreadAgentRow: View {
    let agent: FeatureThreadAgent
    let onOpenThread: @MainActor (String) -> Void

    var body: some View {
        Group {
            if let childID = agent.childThreadID {
                Button { onOpenThread(childID) } label: { content }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isLink)
                    .accessibilityHint("Opens this agent's thread")
            } else {
                content
                    .accessibilityElement(children: .combine)
                    .accessibilityHint("Provider-managed agent. Its work appears in the transcript.")
            }
        }
        .accessibilityIdentifier("thread-agent-\(agent.id)")
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(agent.title)
                    .font(T3Typography.control)
                    .lineLimit(2)
                Spacer(minLength: 0)
                Text(agent.status.label)
                    .font(T3Typography.supporting)
                    .foregroundStyle(agent.status == .failed ? T3Colors.danger : Color.white)
                if agent.childThreadID != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .accessibilityHidden(true)
                }
            }
            HStack(spacing: 8) {
                Text([agent.driver, agent.model].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let started = agent.startedAt, let completed = agent.completedAt, completed > started {
                    Text(Duration.seconds(completed.timeIntervalSince(started)).formatted(.units(
                        allowed: [.hours, .minutes, .seconds], width: .abbreviated, maximumUnitCount: 2
                    )))
                    .monospacedDigit()
                }
            }
            .font(T3Typography.supporting)
            if let detail = agent.detail, !detail.isEmpty {
                Text(detail)
                    .font(T3Typography.supporting)
                    .lineLimit(3)
            }
        }
        .foregroundStyle(Color.white)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

struct FeatureThreadForkButton: View {
    let source: FeatureThreadWorkflowSource?
    let workflows: FeatureThreadWorkflows
    let isBusy: Bool
    let onFork: @MainActor (FeatureThreadWorkflowSource) -> Void

    var body: some View {
        if let source, workflows.canFork(source) {
            Button { onFork(source) } label: {
                Image(systemName: "arrow.triangle.branch")
                    .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            }
            .buttonStyle(.plain)
            .disabled(isBusy)
            .accessibilityLabel(isBusy ? "Creating fork" : "Fork from this response")
            .accessibilityIdentifier("thread-fork-\(source.itemID)")
        }
    }
}

/// Use in both the thread action menu and Git controls. This transfers conversation context.
struct FeatureThreadMergeBackButton: View {
    let workflows: FeatureThreadWorkflows
    let isBusy: Bool
    let onMergeBack: @MainActor () -> Void

    var body: some View {
        if workflows.mergeBack != nil {
            Button(isBusy ? "Sending context…" : "Merge back", systemImage: "arrow.triangle.merge", action: onMergeBack)
                .disabled(isBusy)
                .accessibilityHint("Sends this fork's context back to its source thread")
                .accessibilityIdentifier("thread-merge-back")
        }
    }
}

/// Place beside the existing provider-native read-only composer status.
struct FeatureThreadOpenParentButton: View {
    let workflows: FeatureThreadWorkflows
    let onOpenThread: @MainActor (String) -> Void

    var body: some View {
        if let parentID = workflows.providerParentThreadID {
            Button("Open parent", systemImage: "arrow.up") { onOpenThread(parentID) }
                .accessibilityIdentifier("thread-open-parent")
        }
    }
}
