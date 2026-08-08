import SwiftUI
import WidgetKit

private struct T3TaskWidgetEntry: TimelineEntry {
    var date: Date
    var snapshot: T3TaskWidgetSnapshot
}

private struct T3TaskWidgetProvider: TimelineProvider {
    func placeholder(in _: Context) -> T3TaskWidgetEntry {
        T3TaskWidgetEntry(date: Date(), snapshot: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (T3TaskWidgetEntry) -> Void) {
        let snapshot = context.isPreview ? T3TaskWidgetSnapshot.preview : T3TaskWidgetSnapshotStore.load()
        completion(T3TaskWidgetEntry(date: Date(), snapshot: snapshot))
    }

    func getTimeline(in _: Context, completion: @escaping (Timeline<T3TaskWidgetEntry>) -> Void) {
        let now = Date()
        let entry = T3TaskWidgetEntry(date: now, snapshot: T3TaskWidgetSnapshotStore.load())
        completion(Timeline(entries: [entry], policy: .after(now.addingTimeInterval(15 * 60))))
    }
}

struct T3RecentTasksWidget: Widget {
    private let kind = "T3RecentTasksWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: T3TaskWidgetProvider()) { entry in
            T3TaskWidgetView(entry: entry)
                .containerBackground(Color(uiColor: .systemBackground), for: .widget)
        }
        .configurationDisplayName("T3 Code Tasks")
        .description("See active and recent T3 Code tasks at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

private struct T3TaskWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: T3TaskWidgetEntry

    var body: some View {
        switch family {
        case .systemMedium:
            mediumView
        case .accessoryRectangular:
            accessoryView
        default:
            smallView
        }
    }

    private var orderedTasks: [T3RelayAgentActivityAggregateRow] {
        entry.snapshot.tasks.sorted { left, right in
            let leftPriority = left.phase.widgetPriority
            let rightPriority = right.phase.widgetPriority
            return leftPriority == rightPriority
                ? left.updatedAt > right.updatedAt
                : leftPriority < rightPriority
        }
    }

    private var smallView: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            Spacer(minLength: 0)
            if let task = orderedTasks.first {
                Link(destination: task.nativeDeepLinkURL ?? T3WidgetURLs.newTask) {
                    VStack(alignment: .leading, spacing: 5) {
                        Label(task.status, systemImage: task.phase.systemImage)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(task.phase.tint)
                            .lineLimit(1)
                        Text(task.threadTitle)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                        Text(task.projectTitle)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            } else {
                emptyState
            }
        }
        .widgetURL(orderedTasks.first?.nativeDeepLinkURL ?? T3WidgetURLs.newTask)
    }

    private var mediumView: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if orderedTasks.isEmpty {
                Spacer(minLength: 0)
                emptyState
                Spacer(minLength: 0)
            } else {
                ForEach(Array(orderedTasks.prefix(3).enumerated()), id: \.element.id) { index, task in
                    Link(destination: task.nativeDeepLinkURL ?? T3WidgetURLs.newTask) {
                        HStack(spacing: 8) {
                            Image(systemName: task.phase.systemImage)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(task.phase.tint)
                                .frame(width: 15)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(task.threadTitle)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(task.projectTitle)
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 6)
                            Text(task.status)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(task.phase.tint)
                                .lineLimit(1)
                        }
                    }
                    if index < min(orderedTasks.count, 3) - 1 {
                        Divider()
                    }
                }
            }
        }
    }

    private var accessoryView: some View {
        Group {
            if let task = orderedTasks.first {
                VStack(alignment: .leading, spacing: 2) {
                    Label(task.status, systemImage: task.phase.systemImage)
                        .font(.caption.weight(.semibold))
                    Text(task.threadTitle)
                        .font(.caption2.weight(.medium))
                        .lineLimit(1)
                }
            } else {
                Label("New task", systemImage: "square.and.pencil")
                    .font(.caption.weight(.semibold))
            }
        }
        .widgetURL(orderedTasks.first?.nativeDeepLinkURL ?? T3WidgetURLs.newTask)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text("T3")
                .font(.system(size: 14, weight: .black, design: .rounded))
                .foregroundStyle(.primary)
            Text("Code")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 6)
            Link(destination: T3WidgetURLs.newTask) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
            }
            .accessibilityLabel("New task")
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Ready for a task")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.primary)
            Text("Tap to start in T3 Code")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
        }
    }
}

private enum T3WidgetURLs {
    static let newTask = URL(string: "t3code-swiftui://new-task")!
}

private extension T3AgentActivityPhase {
    var widgetPriority: Int {
        switch self {
        case .waitingForApproval, .waitingForInput: 0
        case .failed: 1
        case .starting, .running: 2
        case .completed, .stale: 3
        }
    }
}

private extension T3TaskWidgetSnapshot {
    static let preview = T3TaskWidgetSnapshot(
        updatedAt: "2026-08-01T12:00:00.000Z",
        tasks: [
            T3RelayAgentActivityAggregateRow(
                environmentId: "preview",
                threadId: "one",
                projectTitle: "t3code",
                threadTitle: "Polish native task list",
                modelTitle: "GPT-5.6 Sol",
                phase: .running,
                status: "Working",
                updatedAt: "2026-08-01T12:00:00.000Z",
                deepLink: "/preview/one"
            ),
            T3RelayAgentActivityAggregateRow(
                environmentId: "preview",
                threadId: "two",
                projectTitle: "uploadthing",
                threadTitle: "Review multipart recovery",
                modelTitle: "Claude Opus 5",
                phase: .waitingForApproval,
                status: "Approval",
                updatedAt: "2026-08-01T11:59:00.000Z",
                deepLink: "/preview/two"
            ),
        ]
    )
}
