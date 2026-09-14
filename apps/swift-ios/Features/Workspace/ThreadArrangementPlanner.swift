import Foundation

enum ThreadArrangementSection: String, CaseIterable, Hashable {
    case pinned, active, snoozed, settled

    var title: String { rawValue.capitalized }

    var orderSection: FeatureThreadOrderSection? {
        switch self {
        case .pinned: .pinned
        case .active: .active
        case .snoozed, .settled: nil
        }
    }
}

struct ThreadArrangementDestination: Equatable {
    let section: ThreadArrangementSection
    var targetID: String? = nil
    var after = false
}

/// Resolves drops against all environments, without the Home project filter.
/// A destination identifies a row rather than an index so a stale drag cannot
/// silently move next to a different thread.
enum ThreadArrangementPlanner {
    enum LifecycleAction: Equatable {
        case pin, unpin, unsettle, unsnooze
    }

    struct Plan {
        let section: FeatureThreadOrderSection?
        let orderedIDs: [String]
        let assignments: [FeatureThreadOrderAssignment]
    }

    static func lifecycle(
        _ thread: FeatureThread,
        section: FeatureThreadOrderSection,
        now: Date
    ) -> [LifecycleAction] {
        if section == .pinned { return [.pin] }
        var actions: [LifecycleAction] = []
        if thread.pinnedAt != nil { actions.append(.unpin) }
        if thread.isEffectivelySettled() { actions.append(.unsettle) }
        if thread.isEffectivelySnoozed(at: now) { actions.append(.unsnooze) }
        return actions
    }

    static func section(of thread: FeatureThread, now: Date) -> ThreadArrangementSection {
        if thread.isEffectivelySnoozed(at: now) { return .snoozed }
        if thread.supportsSettlement == true, thread.isEffectivelySettled() { return .settled }
        return thread.pinnedAt == nil ? .active : .pinned
    }

    static func canEnter(
        _ thread: FeatureThread,
        section: FeatureThreadOrderSection,
        now: Date
    ) -> Bool {
        guard !thread.isArchived, ThreadOrderPlanner.isWritable(thread, section: section) else {
            return false
        }
        let source = self.section(of: thread, now: now)
        if source.orderSection == section { return true }
        if (section == .pinned || thread.pinnedAt != nil), thread.supportsPinning != true {
            return false
        }
        if thread.isEffectivelySettled(), thread.supportsSettlement != true { return false }
        if thread.isEffectivelySnoozed(at: now), thread.supportsSnooze != true { return false }
        return true
    }

    static func plan(
        id: String,
        destination: ThreadArrangementDestination,
        threads: [FeatureThread],
        connectedEnvironmentIDs: Set<String>,
        now: Date
    ) -> Plan? {
        guard let moved = threads.first(where: { $0.id == id }),
              !moved.isArchived,
              connectedEnvironmentIDs.contains(moved.environmentID ?? "") else { return nil }
        if destination.section == .settled {
            guard moved.supportsSettlement == true, !moved.isEffectivelySettled(),
                  moved.canSettleNow(at: now) else { return nil }
            return Plan(section: nil, orderedIDs: [], assignments: [])
        }
        guard let section = destination.section.orderSection,
              canEnter(moved, section: section, now: now) else { return nil }
        let current = DailyUXSidebarIndex.orderedSection(threads, section: section, now: now)
        var ordered = current.filter { $0.id != id }
        let index: Int
        if let target = destination.targetID {
            guard let targetIndex = ordered.firstIndex(where: { $0.id == target }) else { return nil }
            index = targetIndex + (destination.after ? 1 : 0)
        } else {
            index = destination.after ? ordered.count : 0
        }
        ordered.insert(moved, at: index)
        guard ordered.map(\.id) != current.map(\.id),
              let assignments = ThreadOrderPlanner.planDrop(
                ordered: ordered,
                all: threads,
                section: section,
                connectedEnvironmentIDs: connectedEnvironmentIDs,
                movedID: id
              ) else { return nil }
        return Plan(section: section, orderedIDs: ordered.map(\.id), assignments: assignments)
    }
}
