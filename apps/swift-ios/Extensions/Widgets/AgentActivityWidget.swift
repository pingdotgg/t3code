import ActivityKit
import SwiftUI
import WidgetKit

struct T3TaskLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LiveActivityAttributes.self) { context in
            T3LiveActivityLockScreenView(context: context)
                .activityBackgroundTint(Color(uiColor: .systemBackground))
                .activitySystemActionForegroundColor(Color(uiColor: .label))
                .widgetURL(T3ActivityPresentation(state: context.state).deepLinkURL)
        } dynamicIsland: { context in
            let presentation = T3ActivityPresentation(state: context.state)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text("T3")
                        .font(.system(size: 14, weight: .black, design: .rounded))
                        .foregroundStyle(presentation.tint)
                        .padding(.leading, 4)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    Label(presentation.shortStatus, systemImage: presentation.phase.systemImage)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(presentation.tint)
                        .lineLimit(1)
                        .padding(.trailing, 4)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(presentation.rows.prefix(3)) { row in
                            T3LiveActivityRow(row: row)
                        }
                        if presentation.rows.isEmpty {
                            Text(presentation.subtitle)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 2)
                }
            } compactLeading: {
                Text("T3")
                    .font(.system(size: 11, weight: .black, design: .rounded))
                    .foregroundStyle(presentation.tint)
            } compactTrailing: {
                Image(systemName: presentation.phase.systemImage)
                    .foregroundStyle(presentation.tint)
            } minimal: {
                Image(systemName: presentation.phase.systemImage)
                    .foregroundStyle(presentation.tint)
            }
            .widgetURL(presentation.deepLinkURL)
            .keylineTint(presentation.tint)
        }
    }
}

private struct T3LiveActivityLockScreenView: View {
    let context: ActivityViewContext<LiveActivityAttributes>

    private var presentation: T3ActivityPresentation {
        T3ActivityPresentation(state: context.state)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Text("T3 Code")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                Label(presentation.shortStatus, systemImage: presentation.phase.systemImage)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(presentation.tint)
                    .lineLimit(1)
            }

            if presentation.rows.isEmpty {
                Text(presentation.subtitle)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else {
                ForEach(presentation.rows.prefix(4)) { row in
                    T3LiveActivityRow(row: row)
                }
            }
        }
        .padding(15)
    }
}

private struct T3LiveActivityRow: View {
    let row: T3RelayAgentActivityAggregateRow

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: row.phase.systemImage)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(row.phase.tint)
                .frame(width: 14)
            Text(row.threadTitle)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Text(row.projectTitle)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(row.status)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(row.phase.tint)
                .lineLimit(1)
        }
    }
}

private struct T3ActivityPresentation {
    let aggregate: T3RelayAgentActivityAggregateState?

    init(state: LiveActivityAttributes.ContentState) {
        aggregate = state.aggregate
    }

    var rows: [T3RelayAgentActivityAggregateRow] {
        aggregate?.attentionFirstActivities ?? []
    }

    var phase: T3AgentActivityPhase {
        rows.first?.phase ?? .stale
    }

    var tint: Color { phase.tint }

    var shortStatus: String {
        if let row = rows.first(where: {
            $0.phase == .waitingForApproval || $0.phase == .waitingForInput
        }) {
            return row.phase == .waitingForApproval ? "Approval" : "Input"
        }
        guard let aggregate else { return "Updating" }
        if aggregate.activeCount > 0 {
            return "\(aggregate.activeCount) active"
        }
        return rows.contains(where: { $0.phase == .failed }) ? "Failed" : "Done"
    }

    var subtitle: String {
        aggregate?.subtitle ?? "Waiting for the latest task status."
    }

    var deepLinkURL: URL? {
        rows.first?.nativeDeepLinkURL
    }
}

extension T3AgentActivityPhase {
    var tint: Color {
        switch self {
        case .starting, .running:
            Color(uiColor: .systemBlue)
        case .waitingForApproval:
            Color(uiColor: .systemOrange)
        case .waitingForInput:
            Color(uiColor: .systemIndigo)
        case .completed:
            Color(uiColor: .systemGreen)
        case .failed:
            Color(uiColor: .systemRed)
        case .stale:
            Color.secondary
        }
    }
}
