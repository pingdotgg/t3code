import Foundation

struct ThreadSnoozePreset: Identifiable, Equatable {
    let id: String
    let label: String
    let whenLabel: String
    let until: Date

    var menuTitle: String {
        "\(label) (\(whenLabel))"
    }
}

/// Mirrors the shared web client's local-calendar snooze choices.
enum ThreadSnoozePresets {
    private static let eveningHour = 18
    private static let morningHour = 9

    static func resolve(
        now: Date = .now,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> [ThreadSnoozePreset] {
        var presets: [ThreadSnoozePreset] = []

        let inAnHour = now.addingTimeInterval(60 * 60)
        presets.append(
            preset(
                id: "hour",
                label: "In 1 hour",
                until: inAnHour,
                calendar: calendar,
                locale: locale
            )
        )

        if let evening = time(eveningHour, on: now, calendar: calendar),
           evening.timeIntervalSince(now) > 60 * 60 {
            presets.append(
                preset(
                    id: "evening",
                    label: "This evening",
                    until: evening,
                    calendar: calendar,
                    locale: locale
                )
            )
        }

        // Calendar-day advances avoid crossing DST boundaries with a fixed
        // 24-hour offset, which can land on the wrong local day.
        if let nextDay = calendar.date(byAdding: .day, value: 1, to: now),
           let tomorrow = time(morningHour, on: nextDay, calendar: calendar) {
            presets.append(
                preset(
                    id: "tomorrow",
                    label: "Tomorrow",
                    until: tomorrow,
                    calendar: calendar,
                    locale: locale
                )
            )
        }

        let weekdayFromSunday = calendar.component(.weekday, from: now) - 1
        var daysUntilMonday = (1 - weekdayFromSunday + 7) % 7
        if daysUntilMonday == 0 { daysUntilMonday = 7 }
        if let mondayDay = calendar.date(byAdding: .day, value: daysUntilMonday, to: now),
           let nextWeek = time(morningHour, on: mondayDay, calendar: calendar) {
            let weekday = weekdayLabel(nextWeek, calendar: calendar, locale: locale)
            presets.append(
                preset(
                    id: "next-week",
                    label: "Next week",
                    until: nextWeek,
                    calendar: calendar,
                    locale: locale,
                    whenPrefix: weekday
                )
            )
        }

        return presets
    }

    private static func preset(
        id: String,
        label: String,
        until: Date,
        calendar: Calendar,
        locale: Locale,
        whenPrefix: String? = nil
    ) -> ThreadSnoozePreset {
        let time = timeLabel(until, calendar: calendar, locale: locale)
        return ThreadSnoozePreset(
            id: id,
            label: label,
            whenLabel: [whenPrefix, time].compactMap { $0 }.joined(separator: " "),
            until: until
        )
    }

    private static func time(_ hour: Int, on day: Date, calendar: Calendar) -> Date? {
        calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)
    }

    private static func timeLabel(
        _ date: Date,
        calendar: Calendar,
        locale: Locale
    ) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private static func weekdayLabel(
        _ date: Date,
        calendar: Calendar,
        locale: Locale
    ) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "EEE"
        return formatter.string(from: date)
    }
}

enum ThreadContextMenuItem: Equatable {
    case newThread(branch: String)
    case rename
    case regenerateTitle
    case archive(archived: Bool)
    case pin(pinned: Bool)
    case settle(settled: Bool)
    case snooze(presets: [ThreadSnoozePreset], enabled: Bool)
    case unsnooze
    case copyPath
    case copyBranch
    case copyThreadID
    case delete
}

enum ThreadContextMenuModel {
    static func items(
        for thread: FeatureThread,
        isArchived: Bool,
        canCreateThread: Bool = true,
        canCopyPath: Bool = true,
        now: Date = .now,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> [ThreadContextMenuItem] {
        var items: [ThreadContextMenuItem] = []

        if canCreateThread, let branch = nonEmpty(thread.branch) {
            items.append(.newThread(branch: branch))
        }

        if !isArchived {
            if thread.canTogglePin {
                items.append(.pin(pinned: thread.pinnedAt != nil))
            }
            if thread.canToggleSettlement {
                items.append(.settle(settled: thread.isEffectivelySettled(at: now)))
            }
            if thread.canToggleSnooze {
                if thread.isEffectivelySnoozed(at: now) {
                    items.append(.unsnooze)
                } else {
                    items.append(
                        .snooze(
                            presets: ThreadSnoozePresets.resolve(
                                now: now,
                                calendar: calendar,
                                locale: locale
                            ),
                            enabled: thread.canStartSnooze
                        )
                    )
                }
            }
        }

        items.append(.rename)
        if !isArchived, thread.supportsTitleRegeneration == true {
            items.append(.regenerateTitle)
        }
        items.append(.archive(archived: isArchived))
        if canCopyPath {
            items.append(.copyPath)
        }
        if nonEmpty(thread.branch) != nil {
            items.append(.copyBranch)
        }
        items.append(.copyThreadID)
        items.append(.delete)
        return items
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

extension FeatureThread {
    var canStartSnooze: Bool {
        state != .queued && state != .waitingForApproval && state != .waitingForInput
    }

    var newTaskWorkspaceSeed: FeatureComposerWorkspaceDraft? {
        guard let branch = branch?.trimmingCharacters(in: .whitespacesAndNewlines),
              !branch.isEmpty else {
            return nil
        }
        return FeatureComposerWorkspaceDraft(
            mode: .local,
            branch: branch,
            worktreePath: worktreePath,
            startFromOrigin: false
        )
    }
}
