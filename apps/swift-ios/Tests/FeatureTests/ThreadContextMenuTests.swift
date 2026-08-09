import Foundation
import Testing
@testable import T3Code

@Suite("Thread context menu")
struct ThreadContextMenuTests {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }()
    private let locale = Locale(identifier: "en_US_POSIX")

    @Test
    func morningSnoozePresetsMatchTheWebCalendarChoices() throws {
        let now = try #require(calendar.date(from: DateComponents(
            year: 2026,
            month: 4,
            day: 8,
            hour: 10
        )))

        let presets = ThreadSnoozePresets.resolve(
            now: now,
            calendar: calendar,
            locale: locale
        )

        #expect(presets.map(\.id) == ["hour", "evening", "tomorrow", "next-week"])
        #expect(components(of: try preset("evening", in: presets)) == [2026, 4, 8, 18])
        #expect(components(of: try preset("tomorrow", in: presets)) == [2026, 4, 9, 9])
        #expect(components(of: try preset("next-week", in: presets)) == [2026, 4, 13, 9])
        #expect(try preset("next-week", in: presets).whenLabel.hasPrefix("Mon "))
    }

    @Test
    func eveningPresetDisappearsWhenItIsLessThanAnHourAway() throws {
        let now = try #require(calendar.date(from: DateComponents(
            year: 2026,
            month: 4,
            day: 8,
            hour: 17,
            minute: 30
        )))

        let presets = ThreadSnoozePresets.resolve(
            now: now,
            calendar: calendar,
            locale: locale
        )

        #expect(presets.map(\.id) == ["hour", "tomorrow", "next-week"])
    }

    @Test
    func nextWeekIsAFullWeekAwayOnMonday() throws {
        let now = try #require(calendar.date(from: DateComponents(
            year: 2026,
            month: 4,
            day: 6,
            hour: 10
        )))

        let nextWeek = try preset(
            "next-week",
            in: ThreadSnoozePresets.resolve(
                now: now,
                calendar: calendar,
                locale: locale
            )
        )

        #expect(components(of: nextWeek) == [2026, 4, 13, 9])
    }

    @Test
    func activeThreadOffersEverySupportedElectronAction() throws {
        let now = try #require(calendar.date(from: DateComponents(
            year: 2026,
            month: 4,
            day: 8,
            hour: 10
        )))
        var thread = FeatureThread(
            id: "environment:one:thread:thread-1",
            wireID: "thread-1",
            projectID: "project-1",
            title: "Menu parity",
            branch: "feature/menu",
            worktreePath: "/tmp/menu",
            supportsSettlement: true,
            supportsSnooze: true,
            supportsPinning: true,
            supportsTitleRegeneration: true
        )

        let items = ThreadContextMenuModel.items(
            for: thread,
            isArchived: false,
            now: now,
            calendar: calendar,
            locale: locale
        )

        #expect(kinds(items) == [
            "new-thread",
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "archive",
            "copy-path",
            "copy-branch",
            "copy-thread-id",
            "delete",
        ])

        for gatedState in [
            FeatureThreadState.queued,
            .waitingForApproval,
            .waitingForInput,
        ] {
            thread.state = gatedState
            let gatedItems = ThreadContextMenuModel.items(
                for: thread,
                isArchived: false,
                now: now,
                calendar: calendar,
                locale: locale
            )
            let snoozeEnabled = gatedItems.compactMap { item -> Bool? in
                guard case let .snooze(_, enabled) = item else { return nil }
                return enabled
            }.first
            #expect(snoozeEnabled == false)
        }

        thread.state = .idle
        thread.pinnedAt = now
        thread.isSettled = true
        let reverseItems = ThreadContextMenuModel.items(
            for: thread,
            isArchived: false,
            now: now,
            calendar: calendar,
            locale: locale
        )
        #expect(reverseItems.contains(.pin(pinned: true)))
        #expect(reverseItems.contains(.settle(settled: true)))
    }

    @Test
    func archivedThreadsKeepMetadataCopyAndReverseActionsButHideActiveLifecycle() {
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Archived",
            branch: "main",
            isArchived: true,
            supportsTitleRegeneration: true
        )

        let items = ThreadContextMenuModel.items(for: thread, isArchived: true)

        #expect(kinds(items) == [
            "new-thread",
            "rename",
            "restore",
            "copy-path",
            "copy-branch",
            "copy-thread-id",
            "delete",
        ])
    }

    @Test
    func newThreadActionCarriesTheExistingBranchAndWorktree() {
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Existing",
            branch: "feature/existing",
            worktreePath: "/tmp/existing"
        )

        #expect(thread.newTaskWorkspaceSeed == FeatureComposerWorkspaceDraft(
            mode: .local,
            branch: "feature/existing",
            worktreePath: "/tmp/existing",
            startFromOrigin: false
        ))
    }

    @Test
    func unsupportedCapabilitiesHideLifecycleAndRegenerationActions() {
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Unsupported",
            supportsSettlement: false,
            supportsSnooze: false,
            supportsPinning: false,
            supportsTitleRegeneration: false
        )

        #expect(kinds(ThreadContextMenuModel.items(for: thread, isArchived: false)) == [
            "rename",
            "archive",
            "copy-path",
            "copy-thread-id",
            "delete",
        ])

        var unknown = thread
        unknown.supportsTitleRegeneration = nil
        #expect(
            ThreadContextMenuModel.items(for: unknown, isArchived: false)
                .contains(.regenerateTitle) == false
        )
    }

    @Test
    func unavailableProjectHidesNewThreadAction() {
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "disconnected-project",
            title: "Unavailable project",
            branch: "feature/menu"
        )

        let items = ThreadContextMenuModel.items(
            for: thread,
            isArchived: false,
            canCreateThread: false
        )

        #expect(items.contains(.newThread(branch: "feature/menu")) == false)
        #expect(items.contains(.copyBranch))
    }

    @Test
    func snoozedThreadOffersWakeInsteadOfPresets() {
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Snoozed",
            snoozedUntil: .distantFuture,
            supportsSnooze: true
        )

        let items = ThreadContextMenuModel.items(for: thread, isArchived: false)

        #expect(items.contains(.unsnooze))
        #expect(items.contains { item in
            if case .snooze = item { return true }
            return false
        } == false)
    }

    @Test
    func unavailablePathAndBranchDoNotCreateDeadMenuActions() {
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "No workspace",
            branch: "   "
        )

        let items = ThreadContextMenuModel.items(
            for: thread,
            isArchived: false,
            canCopyPath: false
        )

        #expect(items.contains(.copyPath) == false)
        #expect(items.contains(.copyBranch) == false)
        #expect(thread.newTaskWorkspaceSeed == nil)
    }

    @Test
    func untouchedWorkspaceSeedDoesNotBecomeAWorkspaceOnlyDraft() {
        let workspace = FeatureComposerWorkspaceDraft(
            mode: .local,
            branch: "feature/existing",
            worktreePath: "/tmp/existing",
            startFromOrigin: false
        )
        let seedOnly = FeatureComposerDraft(workspace: workspace)

        #expect(
            SeededWorkspaceDraftPersistence.prepare(
                seedOnly,
                workspaceSelectionIsSeeded: true
            ).isEmpty
        )

        let withText = FeatureComposerDraft(text: "Keep this", workspace: workspace)
        #expect(
            SeededWorkspaceDraftPersistence.prepare(
                withText,
                workspaceSelectionIsSeeded: true
            ).workspace == workspace
        )
        #expect(
            SeededWorkspaceDraftPersistence.prepare(
                seedOnly,
                workspaceSelectionIsSeeded: false
            ).workspace == workspace
        )
    }

    @Test
    func missingSeededBranchSurvivesAWorkspaceRefresh() {
        let seeded = FeatureWorkspaceBranch(
            name: "feature/pruned",
            worktreePath: "/tmp/pruned"
        )
        let loaded = [FeatureWorkspaceBranch(name: "main", isCurrent: true)]

        #expect(
            NewTaskWorkspaceDefaults.refreshedSelection(
                seeded,
                in: loaded,
                mode: .local,
                preserveMissingSelection: true
            ) == seeded
        )
    }

    @Test
    func missingOrdinaryBranchFallsBackAfterAWorkspaceRefresh() throws {
        let selected = FeatureWorkspaceBranch(name: "feature/deleted")
        let current = FeatureWorkspaceBranch(name: "main", isCurrent: true)

        #expect(
            NewTaskWorkspaceDefaults.refreshedSelection(
                selected,
                in: [current],
                mode: .local
            ) == current
        )
    }

    private func preset(
        _ id: String,
        in presets: [ThreadSnoozePreset]
    ) throws -> ThreadSnoozePreset {
        try #require(presets.first { $0.id == id })
    }

    private func components(of preset: ThreadSnoozePreset) -> [Int] {
        let components = calendar.dateComponents(
            [.year, .month, .day, .hour],
            from: preset.until
        )
        return [components.year, components.month, components.day, components.hour].compactMap { $0 }
    }

    private func kinds(_ items: [ThreadContextMenuItem]) -> [String] {
        items.map { item in
            switch item {
            case .newThread: "new-thread"
            case .rename: "rename"
            case .regenerateTitle: "regenerate-title"
            case let .archive(archived): archived ? "restore" : "archive"
            case let .pin(pinned): pinned ? "unpin" : "pin"
            case let .settle(settled): settled ? "reopen" : "settle"
            case .snooze: "snooze"
            case .unsnooze: "unsnooze"
            case .copyPath: "copy-path"
            case .copyBranch: "copy-branch"
            case .copyThreadID: "copy-thread-id"
            case .delete: "delete"
            }
        }
    }
}
