import Observation
import SwiftUI

// MARK: - TasksModel (port of useOrbitTaskList in orbitTasks.ts)

/// Every Orbit task this device may read. While the Tasks tab is on screen it follows Orbit's
/// realtime notices and reads the list again on each one, like Conn mobile.
/// The rules for lanes, search, rows and errors live in Rust (`conn-ffi` `phone_tasks`).
@MainActor
@Observable
final class TasksModel {
    enum State {
        case loading
        case loaded(FfiPhoneTasks)
        case failed(FfiPhoneNotice)
    }

    private(set) var state: State = .loading
    private(set) var now = Date()
    /// The lane survives leaving the tab, like the other lists' filters.
    var lane: FfiTaskLane = .inProgress

    @ObservationIgnored private var orbit: OrbitCore?
    @ObservationIgnored private var request: UInt64 = 0
    @ObservationIgnored private var hasList = false
    @ObservationIgnored private var listener: TasksListener?
    @ObservationIgnored private var clock: Task<Void, Never>?

    private static let emptyList = FfiPhoneTasks(tasks: [], runningDurationsMs: [:])

    /// The tab for `query`. Before the list arrives the lanes still show, with no tasks.
    func view(query: String) -> FfiPhoneTasksView {
        let list: FfiPhoneTasks
        if case let .loaded(loaded) = state {
            list = loaded
        } else {
            list = Self.emptyList
        }
        return phoneTasksView(
            list: list,
            lane: lane,
            query: query,
            nowMs: Int64(now.timeIntervalSince1970 * 1000)
        )
    }

    var isLoaded: Bool {
        if case .loaded = state { return true }
        return false
    }

    /// The tab came on screen: follow Orbit's notices, read the list and tick the row timers.
    func appear() {
        guard let orbit = orbitCore() else { return }
        let listener = TasksListener(model: self)
        self.listener = listener
        orbit.startRealtime(listener: listener)
        read()
        clock?.cancel()
        clock = Task { [weak self] in
            // Re-renders every 30 s for the minute timers on running rows (`useNow`).
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                self?.now = Date()
            }
        }
    }

    /// The tab left the screen: stop following Orbit until it comes back.
    func disappear() {
        orbit?.stopRealtime()
        listener = nil
        clock?.cancel()
        clock = nil
    }

    func refresh() async {
        await load()
    }

    fileprivate func read() {
        Task { await load() }
    }

    private func load() async {
        guard let orbit = orbitCore() else { return }
        request &+= 1
        let current = request
        do {
            let list = try await orbit.phoneTasks()
            guard current == request else { return }
            hasList = true
            now = Date()
            state = .loaded(list)
        } catch let FfiError.Orbit(_, reason) {
            guard current == request else { return }
            fail(reason)
        } catch {
            guard current == request else { return }
            fail(.unreachable)
        }
    }

    /// A dropped connection keeps the last good list; any other answer replaces it.
    private func fail(_ reason: FfiOrbitErrorReason) {
        if hasList && reason == .unreachable { return }
        state = .failed(phoneTasksErrorText(reason: reason))
    }

    private func orbitCore() -> OrbitCore? {
        if let orbit { return orbit }
        do {
            let created = try OrbitCore(gatewayUrl: nil)
            orbit = created
            return created
        } catch {
            fail(.unreachable)
            return nil
        }
    }
}

/// Orbit's realtime notices, handed to the model on the main actor.
private final class TasksListener: OrbitListener, @unchecked Sendable {
    private weak var model: TasksModel?

    @MainActor
    init(model: TasksModel) {
        self.model = model
    }

    func onTasksChanged(taskId: Int64?) {
        // The list reads again for any change, to one task or to the list (`onInvalidate`).
        Task { @MainActor [weak model] in
            model?.read()
        }
    }

    func onRealtimeStatus(status: FfiTasksLiveStatus) {}

    func onFleetChanged() {}

    func onProfileChanged() {}
}

// MARK: - TasksTabView (1:1 port of TasksScreen.tsx)

struct TasksTabView: View {
    @Bindable var model: TasksModel
    let searchQuery: String
    @Environment(\.connTheme) private var theme

    /// `TasksTopBar` height.
    private let barHeight: CGFloat = 56
    /// The bar sits where a native one would: its middle 28pt below the safe area's top.
    private let barLift: CGFloat = 8

    var body: some View {
        let view = model.view(query: searchQuery)
        ZStack(alignment: .top) {
            ScrollView {
                LazyVStack(spacing: 0) {
                    content(view)
                }
                .padding(.top, barHeight + 4 - barLift)
            }
            .refreshable { await model.refresh() }
            .background(theme.background)

            TasksTopBar(
                subtitle: model.isLoaded ? view.subtitle : nil,
                lanes: view.lanes,
                onSelectLane: { model.lane = $0 }
            )
            .frame(height: barHeight)
            .padding(.top, -barLift)
        }
        .onAppear { model.appear() }
        .onDisappear { model.disappear() }
    }

    @ViewBuilder
    private func content(_ view: FfiPhoneTasksView) -> some View {
        switch model.state {
        case .loading:
            ProgressView()
                .padding(.top, 40)
                .accessibilityIdentifier("tasks.loading")
        case let .failed(notice):
            VStack(spacing: 4) {
                Text(notice.title)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Text(notice.detail)
                    .font(.system(size: 15))
                    .foregroundStyle(theme.mutedForeground)
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 32)
            .padding(.vertical, 40)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("tasks.error")
        case .loaded:
            if let emptyText = view.emptyText {
                Text(emptyText)
                    .font(.system(size: 15))
                    .foregroundStyle(theme.mutedForeground)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 40)
                    .accessibilityIdentifier("tasks.empty")
            } else {
                ForEach(view.rows, id: \.id) { row in
                    TaskRowView(row: row)
                        .padding(.horizontal, 8)
                        .padding(.bottom, 4)
                }
            }
        }
    }
}

/// Conn turns large titles off: the title stays centred in the bar, a status line under it.
private struct TasksTopBar: View {
    let subtitle: String?
    let lanes: [FfiPhoneTaskLane]
    let onSelectLane: (FfiTaskLane) -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: 44)
            VStack(spacing: 0) {
                Text("Tasks")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(theme.foreground)
                    .frame(height: 20)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 12).monospacedDigit())
                        .foregroundStyle(theme.mutedForeground)
                        .accessibilityIdentifier("tasks.subtitle")
                }
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            .allowsHitTesting(false)

            Menu {
                TaskLaneMenuItems(lanes: lanes, onSelect: onSelectLane)
            } label: {
                ConnIcon("line.3.horizontal.decrease")
                    .font(.system(size: 19))
                    .foregroundStyle(theme.accentForeground)
                    .frame(width: 44, height: 44)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .accessibilityLabel("Filter tasks")
            .accessibilityIdentifier("tasks.laneMenu")
        }
        .padding(.horizontal, 16)
    }
}

/// The lanes as menu items: a check on the selected lane, each lane's task count under its name.
struct TaskLaneMenuItems: View {
    let lanes: [FfiPhoneTaskLane]
    let onSelect: (FfiTaskLane) -> Void

    var body: some View {
        ForEach(lanes, id: \.id) { lane in
            Toggle(isOn: Binding(get: { lane.selected }, set: { _ in onSelect(lane.id) })) {
                Text(lane.label)
                Text("\(lane.count)")
            }
        }
    }
}

// MARK: - TaskRowView (1:1 port of TaskRow in TaskRows.tsx)

/// A task as a list row: the project tile (status dot on its corner) and the title on line 1;
/// project, number, subtasks, time, machine and the pull request under the title.
struct TaskRowView: View {
    let row: FfiPhoneTaskRow
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 12) {
                ProjectTileView(letter: row.tileLetter, colorIndex: Int(row.tileColorIndex))
                    .overlay(alignment: .topTrailing) {
                        StatusBadgeDot(dot: row.dot)
                            .offset(x: 4, y: -4)
                    }
                    .padding(.top, 2.5)
                Text(row.title)
                    .font(.system(size: 16, weight: row.recede ? .regular : .medium))
                    .foregroundStyle(theme.foreground)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, minHeight: 23, alignment: .leading)
            }
            HStack(spacing: 0) {
                Text(row.pullRequest == nil ? row.detail : row.detail + " · ")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
                    .lineLimit(1)
                    .layoutPriority(-1)
                if let pr = row.pullRequest {
                    HStack(spacing: 3) {
                        ConnIcon(pr.state == .merged ? "arrow.triangle.merge" : "arrow.triangle.pull")
                            .font(.system(size: 12))
                        Text("#\(pr.number)")
                            .font(.system(size: 13).monospacedDigit())
                    }
                    .foregroundStyle(pullRequestColor(pr.state))
                    .fixedSize()
                }
            }
            .padding(.leading, 30)
        }
        .padding(EdgeInsets(top: 12, leading: 4, bottom: 12, trailing: 8))
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityIdentifier("tasks.row.\(row.id)")
    }

    private func pullRequestColor(_ state: FfiPullRequestState?) -> Color {
        switch state {
        case .merged?: AdaptiveColor.violet600400.color(colorScheme)
        case .closed?: theme.destructive
        case .open?, nil: AdaptiveColor.emerald700300.color(colorScheme)
        }
    }
}

/// Orbit projects carry no favicon, so a task row shows a lettered tile in a stable colour.
private struct ProjectTileView: View {
    let letter: String
    let colorIndex: Int

    /// Mobile's `PROJECT_COLORS`; Rust picks the index from the project name.
    private static let colors: [UInt32] = [
        0x6366F1, 0x0EA5E9, 0x10B981, 0xF59E0B, 0xEC4899, 0x8B5CF6, 0x14B8A6, 0xEF4444,
    ]

    var body: some View {
        let hex = Self.colors[colorIndex % Self.colors.count]
        Text(letter)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 18, height: 18)
            .background(
                RoundedRectangle(cornerRadius: 5).fill(Color(rgbHex: hex))
            )
            .accessibilityHidden(true)
    }
}

/// A 6pt status dot in a 2pt ring of the screen colour (`StatusBadgeDot`).
private struct StatusBadgeDot: View {
    let dot: FfiTaskDot
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Circle()
            .fill(fill)
            .frame(width: 6, height: 6)
            .padding(2)
            .background(Circle().fill(theme.background))
            .allowsHitTesting(false)
    }

    private var fill: Color {
        switch dot {
        case .working: AdaptiveColor.sky600400.color(colorScheme)
        case .waiting: theme.mutedForeground
        case .done: AdaptiveColor.emerald600400.color(colorScheme)
        case .failed: theme.destructive
        }
    }
}

// MARK: - Adaptive colours

/// Conn mobile's `adaptive-*` colours: one Tailwind shade in light mode, a lighter one in dark
/// mode (`generated-uniwind-themes.css`). They do not change with the Conn theme.
enum AdaptiveColor {
    case sky600400
    case emerald600400
    case emerald700300
    case violet600400

    func color(_ scheme: ColorScheme) -> Color {
        let (light, dark): (UInt32, UInt32) = switch self {
        case .sky600400: (0x0084D1, 0x00BCFF)
        case .emerald600400: (0x009966, 0x00D492)
        case .emerald700300: (0x007A55, 0x5EE9B5)
        case .violet600400: (0x7F22FE, 0xA684FF)
        }
        return Color(rgbHex: scheme == .dark ? dark : light)
    }
}

extension Color {
    /// A colour from `0xRRGGBB`.
    init(rgbHex hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0
        )
    }
}
