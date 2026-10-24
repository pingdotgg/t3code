import SwiftUI

struct FeatureThreadAgentsView: View {
    let roster: FeatureThreadAgentRoster?
    let onOpenThread: @MainActor (String) -> Void
    var stopContext: FeatureSubagentStopContext? = nil
    @State private var stoppableIDs: Set<String> = []
    @State private var stopTargetsThreadID: String?
    @State private var stoppingID: String?
    @State private var stopError: String?
    @State private var stopTask: Task<Void, Never>?

    private struct LoadKey: Equatable {
        struct Agent: Equatable {
            let id: String
            let runID: String?
            let status: FeatureThreadAgent.Status
        }
        let agents: [Agent]
        let threadID: String?
        let canOperate: Bool
    }

    var body: some View {
        scrollContent
            .background(Color.black)
            .foregroundStyle(Color.white)
            .tint(.white)
            .buttonStyle(.plain)
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .task(id: loadKey) { await loadStopTargets() }
            .onDisappear { stopTask?.cancel(); stopTask = nil }
    }

    private var scrollContent: some View {
        ScrollView {
            agentList.padding(.horizontal, 18).padding(.bottom, 16)
        }
    }

    private var agentList: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            if let roster, !roster.agents.isEmpty {
                ForEach(roster.agents) { agent in
                    agentRow(agent)
                    Divider().overlay(Color.white.opacity(0.18))
                }
            } else {
                Text("No agents in this turn.").font(T3Typography.supporting).padding(.vertical, 16)
            }
            if let stopError {
                Text(stopError).font(T3Typography.supporting).foregroundStyle(T3Colors.danger).padding(.vertical, 8)
            }
        }
    }

    private var loadKey: LoadKey {
        LoadKey(agents: (roster?.agents ?? []).map { LoadKey.Agent(id: $0.id, runID: $0.runID, status: $0.status) },
            threadID: stopContext?.threadID, canOperate: stopContext?.canOperate == true)
    }

    private func loadStopTargets() async {
        guard let context = stopContext, context.canOperate else {
            stoppableIDs = []
            stopTargetsThreadID = nil
            stopError = nil
            return
        }
        if stopTargetsThreadID != context.threadID {
            stoppableIDs = []
            stopTargetsThreadID = context.threadID
        }
        do {
            let ids = try await context.client.stoppableSubagentIDs(threadID: context.threadID)
            guard !Task.isCancelled else { return }
            stoppableIDs = ids
            stopError = nil
        } catch {
            guard !Task.isCancelled else { return }
            stopError = error.localizedDescription
        }
    }

    private func agentRow(_ agent: FeatureThreadAgent) -> FeatureThreadAgentRow {
        let action: (@MainActor () -> Void)?
        if stopContext?.canOperate == true && stopTargetsThreadID == stopContext?.threadID
            && agent.status.isActive && stoppableIDs.contains(agent.id) {
            action = { stop(agent.id) }
        } else { action = nil }
        return FeatureThreadAgentRow(agent: agent, onOpenThread: onOpenThread, onStop: action,
            isStopping: stoppingID == agent.id, stopDisabled: stoppingID != nil)
    }

    private func stop(_ id: String) {
        guard let context = stopContext, context.canOperate, stoppingID == nil else { return }
        stoppingID = id
        stopError = nil
        stopTask = Task { @MainActor in
            defer { stoppingID = nil; stopTask = nil }
            do { try await context.client.stopSubagent(threadID: context.threadID, subagentID: id) }
            catch {
                guard !Task.isCancelled else { return }
                stopError = error.localizedDescription
            }
        }
    }
}

/// Shared by the roster and transcript. Only children with a real thread ID are links.
struct FeatureThreadAgentRow: View {
    let agent: FeatureThreadAgent
    let onOpenThread: @MainActor (String) -> Void
    var onStop: (@MainActor () -> Void)? = nil
    var isStopping = false
    var stopDisabled = false

    var body: some View {
        HStack(spacing: 12) {
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
            if let onStop {
                Button(isStopping ? "Stopping…" : "Stop", role: .destructive, action: onStop)
                    .font(T3Typography.control)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    .disabled(stopDisabled)
                    .accessibilityLabel(isStopping ? "Stopping \(agent.title)" : "Stop \(agent.title)")
                    .accessibilityIdentifier("thread-agent-stop-\(agent.id)")
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
