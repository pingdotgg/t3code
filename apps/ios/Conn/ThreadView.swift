import DesignKit
import SwiftUI

struct ThreadView: View {
    @Bindable var store: CoreStore
    let threadId: String
    let initialTitle: String
    let initialBranch: String?
    let onOpenThread: (String) -> Void

    @Environment(\.connTheme) private var theme
    @State private var draft = ""
    @State private var stickToBottom = true

    private var snapshot: FfiThreadSnapshot? {
        guard let current = store.openThread, current.threadId == threadId else { return nil }
        return current
    }

    private var displayTitle: String {
        if let title = snapshot?.title, !title.isEmpty { return title }
        return initialTitle.isEmpty ? "Thread" : initialTitle
    }

    private var displayBranch: String? {
        snapshot?.branch ?? initialBranch
    }

    private var isWorking: Bool {
        snapshot?.working == true
    }

    private var hasDraft: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var scrollFingerprint: String {
        guard let snapshot else { return "loading" }
        let last = snapshot.entries.last.map(entryFingerprint) ?? "empty"
        return "\(snapshot.entries.count):\(snapshot.working):\(snapshot.queuedCount):\(last)"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Kit.Space.l) {
                    if let error = store.lastError, !error.isEmpty {
                        KitNotice(error, icon: .warning, tone: .error)
                    }

                    metadataHeader

                    if let snapshot {
                        if snapshot.entries.isEmpty {
                            Text("No messages in this thread yet.")
                                .font(.kitDetail)
                                .foregroundStyle(theme.mutedForeground)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 48)
                        } else {
                            let items = renderItems(for: snapshot)
                            ForEach(items) { item in
                                switch item {
                                case let .workGroup(group, entries):
                                    WorkGroupCard(group: group, entries: entries)
                                case let .entry(entry):
                                    TimelineEntryRow(
                                        threadId: threadId,
                                        entry: entry,
                                        store: store,
                                        onOpenThread: onOpenThread
                                    )
                                }
                            }
                        }

                        if snapshot.working {
                            HStack(spacing: Kit.Space.m) {
                                KitStatusIcon(.working, size: 14, label: "Working")
                                Text("Working…")
                                    .font(.kitDetail)
                                    .foregroundStyle(theme.mutedForeground)
                            }
                            .padding(.top, Kit.Space.xs)
                        }
                    } else {
                        HStack(spacing: Kit.Space.m) {
                            KitStatusIcon(.working, size: 16, label: "Loading")
                            Text("Loading timeline…")
                                .font(.kitDetail)
                                .foregroundStyle(theme.mutedForeground)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("timeline-bottom")
                }
                .padding(.horizontal, Kit.contentInset)
                .padding(.top, Kit.Space.m)
                .padding(.bottom, Kit.Space.l)
            }
            .background(theme.background.ignoresSafeArea())
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geo in
                let maxOffset = max(0, geo.contentSize.height - geo.containerSize.height)
                return geo.contentOffset.y >= maxOffset - 80
            } action: { _, nearBottom in
                stickToBottom = nearBottom
            }
            .onChange(of: scrollFingerprint) { _, _ in
                if stickToBottom {
                    withAnimation(Kit.Motion.fast) {
                        proxy.scrollTo("timeline-bottom", anchor: .bottom)
                    }
                }
            }
            .kitComposerBar {
                VStack(alignment: .leading, spacing: Kit.Space.xs) {
                    if let queued = snapshot?.queuedCount, queued > 0 {
                        KitBadge("\(queued) queued")
                            .accessibilityIdentifier("thread.queuedBadge")
                    }

                    KitComposer(
                        isWorking ? "Queue a follow-up…" : "Message…",
                        text: $draft,
                        maxLines: 6,
                        isBusy: isWorking && !hasDraft,
                        canSend: hasDraft && !store.isSending,
                        onSend: {
                            sendDraft(scrollProxy: proxy)
                        },
                        onStop: {
                            Task {
                                await store.stopThread(threadId: threadId)
                            }
                        },
                        leading: {
                            // TODO(wave3): wire attachments and model picker
                            Menu {
                                Button("Attachments (coming soon)") {}
                                    .disabled(true)
                                Button("Model Picker (coming soon)") {}
                                    .disabled(true)
                            } label: {
                                Image(systemName: "plus")
                                    .font(.system(size: 16, weight: .medium))
                                    .foregroundStyle(theme.mutedForeground)
                                    .frame(width: 28, height: 28)
                            }
                            .accessibilityLabel("More composer actions")
                        },
                        trailing: {
                            if isWorking && hasDraft {
                                Button {
                                    Task {
                                        await store.stopThread(threadId: threadId)
                                    }
                                } label: {
                                    KitIconImage(.stop, size: 13)
                                        .foregroundStyle(theme.destructive)
                                        .frame(width: 28, height: 28)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Stop")
                            }
                        }
                    )
                    .accessibilityIdentifier("thread.composer")
                }
            }
        }
        .navigationTitle(displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if isWorking {
                        Button(role: .destructive) {
                            Task {
                                await store.stopThread(threadId: threadId)
                            }
                        } label: {
                            Label("Stop Run", systemImage: "stop.circle")
                        }
                    }
                    Button {
                        Task {
                            await store.settleThread(threadId: threadId, settled: true)
                        }
                    } label: {
                        Label("Settle Thread", systemImage: "checkmark.circle")
                    }
                    Button {
                        Task {
                            await store.markThreadUnread(threadId: threadId)
                        }
                    } label: {
                        Label("Mark Unread", systemImage: "envelope.badge")
                    }
                } label: {
                    KitIconImage(.more, size: 16)
                }
                .accessibilityLabel("Thread actions")
            }
        }
        .task(id: threadId) {
            store.openThread(threadId)
        }
        .onDisappear {
            store.closeThread(threadId)
        }
    }

    @ViewBuilder
    private var metadataHeader: some View {
        let hasBranch = !(displayBranch?.isEmpty ?? true)
        let hasModel = !(snapshot?.modelLabel?.isEmpty ?? true)
        if hasBranch || hasModel {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Kit.Space.s) {
                    if let branch = displayBranch, !branch.isEmpty {
                        KitBadge(branch, icon: .branch, monospaced: true)
                    }
                    if let model = snapshot?.modelLabel, !model.isEmpty {
                        KitBadge(model)
                    }
                }
            }
        }
    }

    private func sendDraft(scrollProxy: ScrollViewProxy) {
        let message = draft
        stickToBottom = true
        Task {
            let sent = await store.sendMessage(threadId: threadId, text: message, mode: .auto)
            if sent {
                draft = ""
                withAnimation(Kit.Motion.fast) {
                    scrollProxy.scrollTo("timeline-bottom", anchor: .bottom)
                }
            }
        }
    }

    private enum RenderItem: Identifiable {
        case workGroup(FfiWorkGroupTiming, [FfiTimelineEntry])
        case entry(FfiTimelineEntry)

        var id: String {
            switch self {
            case let .workGroup(group, _): "wg:\(group.id)"
            case let .entry(entry): "e:\(entry.entryId)"
            }
        }
    }

    private func renderItems(for snapshot: FfiThreadSnapshot) -> [RenderItem] {
        var groupByFirstId: [String: FfiWorkGroupTiming] = [:]
        var memberIds = Set<String>()
        for group in snapshot.workGroups {
            groupByFirstId[group.firstEntryId] = group
            for id in group.entryIds {
                memberIds.insert(id)
            }
        }

        let entriesById = Dictionary(uniqueKeysWithValues: snapshot.entries.map { ($0.entryId, $0) })
        var items: [RenderItem] = []

        for entry in snapshot.entries {
            let id = entry.entryId
            if let group = groupByFirstId[id] {
                let groupedEntries = group.entryIds.compactMap { entriesById[$0] }
                if !groupedEntries.isEmpty {
                    items.append(.workGroup(group, groupedEntries))
                }
            } else if memberIds.contains(id) {
                continue
            } else {
                items.append(.entry(entry))
            }
        }
        return items
    }

    private func entryFingerprint(_ entry: FfiTimelineEntry) -> String {
        switch entry {
        case let .user(id, text, _, _, _, _, _): "u:\(id):\(text.count)"
        case let .queuedUser(id, _, _, text, _, _, _): "q:\(id):\(text.count)"
        case let .assistant(id, markdown, streaming, _, _, _): "a:\(id):\(streaming):\(markdown.count)"
        case let .thinking(id, text, streaming, _, _): "th:\(id):\(streaming):\(text.count)"
        case let .tool(id, _, title, detail, status, _, _, _): "t:\(id):\(status):\(title.count):\(detail?.count ?? 0)"
        case let .approval(id, _, title, _): "ap:\(id):\(title.count)"
        case let .userInputRequest(id, _, _, questions, _, pending, answers, _, _):
            "ui:\(id):\(pending):\(questions.count):\(answers.count)"
        case let .secretRequest(id, label, _, _, _, _, status, pending, _):
            "sec:\(id):\(status):\(pending):\(label.count)"
        case let .proposedPlan(id, _, title, markdown, _, _, _, streaming, _, _):
            "plan:\(id):\(streaming):\(title.count):\(markdown.count)"
        case let .subagent(id, _, title, _, status, _, _, summary, _, _, _, _):
            "sub:\(id):\(status):\(title.count):\(summary?.count ?? 0)"
        case let .turnCheckpoint(id, _, _, fileCount, additions, deletions, _):
            "cp:\(id):\(fileCount):\(additions):\(deletions)"
        case let .notice(id, text, isError): "n:\(id):\(isError):\(text.count)"
        case let .other(id, label): "o:\(id):\(label.count)"
        }
    }
}
