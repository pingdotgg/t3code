import Testing
import UIKit
@testable import T3Code

@MainActor
@Suite("Native keyboard commands")
struct FeatureKeyboardCommandsTests {
    @Test
    func reregisteredBackgroundScopeDoesNotReplaceVisibleModal() {
        let dispatcher = FeatureKeyboardDispatcher()
        let thread = KeyboardTestPresenter()
        let newTask = UIViewController()
        thread.modal = newTask
        var events: [String] = []
        let threadID = UUID()
        dispatcher.updateScope(id: threadID, context: .init(enabledCommands: [.files]),
            presenter: thread) { _ in events.append("hidden") }
        dispatcher.updateScope(id: UUID(), context: .init(enabledCommands: [.cycleHost]),
            presenter: newTask) { _ in events.append("modal") }
        dispatcher.removeScope(id: threadID)
        dispatcher.updateScope(id: threadID, context: .init(enabledCommands: [.files]),
            presenter: thread) { _ in events.append("hidden") }

        #expect(dispatcher.activePresenter === newTask)
        #expect(!dispatcher.perform(.files))
        #expect(dispatcher.perform(.cycleHost))
        #expect(events == ["modal"])
    }

    @Test
    func newTaskModalHidesBackgroundThreadCommandsAndDefersRootActions() throws {
        let dispatcher = FeatureKeyboardDispatcher()
        let thread = UIViewController()
        let newTask = UIViewController()
        var events: [String] = []
        var afterDismissal: (@MainActor () -> Void)?
        dispatcher.update(context: .init(enabledCommands: [.newTask, .threadJump(1)]), paletteContent: {
            .init(items: [.init(id: "settings", title: "Settings") { events.append("settings") }])
        }, onCommand: { events.append($0.id) })
        dispatcher.updateScope(id: UUID(), context: .init(enabledCommands: [.files, .terminal, .review]),
            presenter: thread) { events.append("hidden:\($0.id)") }
        let previouslyVisibleFiles = try #require(dispatcher.content().items.first { $0.id == "files" })
        let modalID = UUID()
        dispatcher.updateScope(id: modalID, context: .init(enabledCommands: []), presenter: newTask,
            beforeRootAction: { afterDismissal = $0 }) { _ in }

        #expect(!dispatcher.context.allows(.files))
        #expect(!dispatcher.perform(.terminal))
        #expect(!dispatcher.content().items.contains { $0.id == "review" })
        previouslyVisibleFiles.run()
        #expect(events.isEmpty)
        #expect(dispatcher.perform(.threadJump(1)))
        #expect(events.isEmpty)
        afterDismissal?()
        #expect(events == ["thread.jump.1"])
        try #require(dispatcher.content().items.first { $0.id == "settings" }).run()
        #expect(events == ["thread.jump.1"])
        afterDismissal?()
        #expect(events == ["thread.jump.1", "settings"])

        dispatcher.removeScope(id: modalID)
        #expect(dispatcher.perform(.files))
        #expect(events.last == "hidden:files")
    }

    @Test
    func nestedUnregisteredModalBlocksCommandsFromItsPresentingTool() {
        let dispatcher = FeatureKeyboardDispatcher()
        let tool = KeyboardTestPresenter()
        let child = UIViewController()
        tool.addChild(child)
        var calls = 0
        dispatcher.updateScope(id: UUID(), context: .init(enabledCommands: [.back, .files]),
            presenter: child) { _ in calls += 1 }
        tool.modal = UIViewController()
        #expect(!dispatcher.perform(.back))
        #expect(!dispatcher.perform(.files))
        #expect(calls == 0)
        tool.modal = nil
        #expect(dispatcher.perform(.back))
        #expect(calls == 1)
    }

    @Test
    func navigationClosesPaletteBeforeStartingSheetDismissal() {
        let dispatcher = FeatureKeyboardDispatcher()
        var afterPaletteDismissal: (@MainActor () -> Void)?
        var events: [String] = []
        dispatcher.dismissPalette = { action in
            events.append("dismiss-palette")
            afterPaletteDismissal = action
        }
        dispatcher.afterDismissingPalette { events.append("dismiss-thread-sheet") }
        #expect(events == ["dismiss-palette"])
        afterPaletteDismissal?()
        #expect(events == ["dismiss-palette", "dismiss-thread-sheet"])
    }

    @Test
    func navigationWaitsForNestedPreviewsAndOnlyResumesLatestRequestOnce() {
        var dismissal = FeatureRootNavigationDismissal()
        let context = UUID(), attachment = UUID(), first = UUID(), latest = UUID()
        dismissal.childPresentationChanged(context, isPresented: true)
        dismissal.childPresentationChanged(attachment, isPresented: true)
        dismissal.request(first, hasPresentation: true)
        #expect(dismissal.takeReadyRequest() == nil)
        dismissal.presentationDidDismiss()
        dismissal.childPresentationChanged(context, isPresented: false)
        #expect(dismissal.takeReadyRequest() == nil)
        dismissal.request(latest, hasPresentation: false)
        dismissal.childPresentationChanged(attachment, isPresented: false)
        #expect(dismissal.takeReadyRequest() == latest)
        #expect(dismissal.takeReadyRequest() == nil)
        dismissal.request(first, hasPresentation: false)
        #expect(dismissal.takeReadyRequest() == first)
    }

    @Test
    func replacementNavigationStillWaitsForSheetAlreadyDismissing() {
        var dismissal = FeatureRootNavigationDismissal()
        dismissal.request(UUID(), hasPresentation: true)
        let latest = UUID()
        dismissal.request(latest, hasPresentation: false)
        #expect(dismissal.takeReadyRequest() == nil)
        dismissal.presentationDidDismiss()
        #expect(dismissal.takeReadyRequest() == latest)
    }

    @Test
    func navigationDuringInteractiveDismissalWaitsForCompletion() {
        var dismissal = FeatureRootNavigationDismissal()
        dismissal.presentationDidAppear()
        let request = UUID()
        // SwiftUI has cleared its binding, but UIKit has not finished dismissal.
        dismissal.request(request, hasPresentation: false)
        #expect(dismissal.takeReadyRequest() == nil)
        dismissal.presentationDidDismiss()
        #expect(dismissal.takeReadyRequest() == request)
    }

    @Test
    func backgroundPaletteRefreshKeepsRowsSelectionAndScrollUntilQueryOrKeyboardMoves() throws {
        let dispatcher = FeatureKeyboardDispatcher()
        let table = KeyboardTestTable()
        var revision = 1
        var selectedRevision: Int?
        var content = FeatureCommandPaletteContent(items: [
            .init(id: "a", kind: .thread, title: "Alpha") {},
            .init(id: "b", kind: .thread, title: "Beta") {},
        ])
        dispatcher.update(context: .init(enabledCommands: []), paletteContent: { content }, onCommand: { _ in })
        let palette = FeatureCommandPaletteController(dispatcher: dispatcher, table: table) { $0?() }
        palette.loadViewIfNeeded()
        #expect(table.reloadCount == 1)
        #expect(table.scrolledRows.isEmpty)
        let down = try #require(palette.keyCommands?.first { $0.input == UIKeyCommand.inputDownArrow })
        palette.perform(down.action, with: down)
        #expect(table.indexPathForSelectedRow?.row == 1)
        #expect(table.scrolledRows == [1])
        let firstRow = palette.tableView(table, cellForRowAt: IndexPath(row: 0, section: 0))
        #expect((firstRow.contentConfiguration as? UIListContentConfiguration)?.text == "Alpha")

        // New updatedAt order and fresh closures must not reorder visible rows.
        content.items.reverse()
        revision = 2
        content.items[1] = .init(id: "a", kind: .thread, title: "Alpha") { selectedRevision = revision }
        palette.reloadResults()
        #expect(table.reloadCount == 1)
        #expect(table.indexPathForSelectedRow?.row == 1)
        #expect(table.scrolledRows == [1])
        let header = try #require(palette.view.subviews.compactMap { $0 as? UIStackView }.first)
        let input = try #require(header.arrangedSubviews.compactMap { $0 as? UITextField }.first)
        input.text = "Alpha"
        input.sendActions(for: .editingChanged)
        #expect(table.reloadCount == 2)
        #expect(table.indexPathForSelectedRow?.row == 0)
        #expect(table.scrolledRows == [1, 0])
        // A changed query moves selection even when the result IDs are identical.
        input.text = "Alph"
        input.sendActions(for: .editingChanged)
        #expect(table.scrolledRows == [1, 0, 0])
        _ = palette.textFieldShouldReturn(input)
        // Dismissal completion is owned by UIKit; the queued closure is fresh.
        palette.presentationControllerDidDismiss(UIPresentationController(presentedViewController: palette, presenting: nil))
        #expect(selectedRevision == 2)
    }

    @Test
    func paletteUpdatesChangedLabelsAndSearchingStateWithoutScrolling() throws {
        let dispatcher = FeatureKeyboardDispatcher()
        let table = KeyboardTestTable()
        var content = FeatureCommandPaletteContent(items: [.init(id: "a", title: "Old") {}])
        dispatcher.update(context: .init(enabledCommands: []), paletteContent: { content }, onCommand: { _ in })
        let palette = FeatureCommandPaletteController(dispatcher: dispatcher, table: table) { _ in }
        palette.loadViewIfNeeded()
        content.items = [.init(id: "a", title: "Renamed") {}]
        palette.reloadResults()
        let cell = palette.tableView(table, cellForRowAt: IndexPath(row: 0, section: 0))
        #expect((cell.contentConfiguration as? UIListContentConfiguration)?.text == "Renamed")
        content.items = []
        content.isSearching = true
        palette.reloadResults()
        #expect((table.backgroundView as? UILabel)?.text == "Searching…")
        let reloadCount = table.reloadCount
        palette.reloadResults()
        #expect(table.reloadCount == reloadCount)
        content.isSearching = false
        palette.reloadResults()
        #expect((table.backgroundView as? UILabel)?.text == "No results")
        #expect(table.scrolledRows.isEmpty)
    }

    @Test
    func rootNavigationWaitsForToolDismissalWhileToolCommandsRemainLocal() throws {
        let dispatcher = FeatureKeyboardDispatcher()
        var events: [String] = []
        var afterDismissal: (@MainActor () -> Void)?
        dispatcher.update(context: .init(enabledCommands: [.newTask]), paletteContent: {
            .init(items: [.init(id: "settings", title: "Settings") { events.append("settings") }])
        }, onCommand: { events.append($0.id) })
        dispatcher.updateScope(id: UUID(), context: .init(enabledCommands: [.files]),
            beforeRootAction: { afterDismissal = $0 }) { events.append($0.id) }
        #expect(dispatcher.perform(.files))
        #expect(dispatcher.perform(.newTask))
        #expect(events == ["files"])
        afterDismissal?()
        #expect(events == ["files", "newTask"])
        afterDismissal = nil
        try #require(dispatcher.content().items.first { $0.id == "settings" }).run()
        #expect(events == ["files", "newTask"])
        afterDismissal?()
        #expect(events == ["files", "newTask", "settings"])
    }

    @Test
    func terminalRetainsItsInputAndCopyKeys() {
        let context = FeatureKeyboardContext(
            enabledCommands: Set(FeatureKeyboardCommand.paletteActions + [.commandPalette, .threadJump(1)]),
            isTerminalActive: true
        )
        let shortcuts = FeatureKeyboardShortcut.available(in: context, isPad: true)
        #expect(!shortcuts.contains { $0.command == .copyThreadReference })
        #expect(shortcuts.contains { $0.command == .terminal })
        #expect(shortcuts.contains { $0.command == .commandPalette })
        #expect(!shortcuts.contains { $0.modifiers.contains(.control) })
        #expect(!shortcuts.contains { $0.input == "\r" || $0.input == UIKeyCommand.inputEscape })
        #expect(!shortcuts.contains { $0.input == "c" && $0.modifiers == .command })
        #expect(!shortcuts.contains { $0.input == "v" && $0.modifiers == .command })
    }

    @Test
    func phoneAndPadKeepRNCommandKMappings() {
        let context = FeatureKeyboardContext(enabledCommands: [.focusSearch, .commandPalette, .threadJump(1)])
        let phone = FeatureKeyboardShortcut.available(in: context, isPad: false)
        let pad = FeatureKeyboardShortcut.available(in: context, isPad: true)
        #expect(phone.first { $0.input == "k" }?.command == .focusSearch)
        #expect(pad.first { $0.input == "k" }?.command == .commandPalette)
        #expect(!phone.contains { $0.command == .threadJump(1) })
        #expect(pad.contains { $0.input == "1" && $0.command == .threadJump(1) })
    }

    @Test
    func dispatchAndPreviouslyShownPaletteActionsUseTheLatestContext() throws {
        let dispatcher = FeatureKeyboardDispatcher()
        var performed: [FeatureKeyboardCommand] = []
        dispatcher.update(
            context: .init(enabledCommands: [.files, .review]),
            paletteContent: { .init() },
            onCommand: { performed.append($0) }
        )
        let openFiles = try #require(dispatcher.content().items.first { $0.id == "files" })
        #expect(dispatcher.perform(.review))
        #expect(!dispatcher.perform(.threadJump(1)))

        dispatcher.update(
            context: .init(enabledCommands: [.newTask]),
            paletteContent: { .init() },
            onCommand: { performed.append($0) }
        )
        openFiles.run()
        #expect(!dispatcher.perform(.files))
        #expect(performed == [.review])
        #expect(dispatcher.content().items.map(\.id) == ["newTask"])
    }

    @Test
    func paletteAndNativeCommandsShareTheDispatcher() throws {
        let dispatcher = FeatureKeyboardDispatcher()
        var performed: [FeatureKeyboardCommand] = []
        var opened = 0
        dispatcher.update(
            context: .init(enabledCommands: [.commandPalette, .cycleHost]),
            paletteContent: { .init() },
            onCommand: { performed.append($0) }
        )
        dispatcher.presentPalette = { opened += 1 }
        #expect(dispatcher.perform(.commandPalette))
        let nextComputer = try #require(dispatcher.content().items.first { $0.id == "cycleHost" })
        nextComputer.run()
        #expect(dispatcher.perform(.cycleHost))
        #expect(opened == 1)
        #expect(performed == [.cycleHost, .cycleHost])
    }

    @Test
    func onlyValidEnabledThreadPositionsAreRegistered() {
        let context = FeatureKeyboardContext(enabledCommands: [.threadJump(0), .threadJump(3), .threadJump(10)])
        #expect(!context.allows(.threadJump(0)))
        #expect(!context.allows(.threadJump(10)))
        #expect(!context.allows(.threadJump(1)))
        #expect(FeatureKeyboardShortcut.available(in: context, isPad: true).map(\.command) == [.threadJump(3)])
    }

    @Test
    func visibleScreenScopeOverridesRootAndIsRemovedWithoutLosingWorkspaceCommands() {
        let dispatcher = FeatureKeyboardDispatcher()
        let threadScope = UUID()
        let terminalScope = UUID()
        var handled: [String] = []
        dispatcher.update(
            context: .init(enabledCommands: [.newTask, .back]),
            paletteContent: { .init() },
            onCommand: { handled.append("workspace:\($0.id)") }
        )
        dispatcher.updateScope(
            id: threadScope,
            context: .init(enabledCommands: [.files, .copyThreadReference]),
            onCommand: { handled.append("thread:\($0.id)") }
        )
        dispatcher.updateScope(
            id: terminalScope,
            context: .init(enabledCommands: [.back], isTerminalActive: true),
            onCommand: { handled.append("terminal:\($0.id)") }
        )
        #expect(dispatcher.perform(.newTask))
        #expect(dispatcher.perform(.back))
        #expect(!dispatcher.perform(.copyThreadReference))
        dispatcher.removeScope(id: terminalScope)
        #expect(dispatcher.perform(.copyThreadReference))
        #expect(dispatcher.perform(.back))
        dispatcher.removeScope(id: threadScope)
        #expect(!dispatcher.perform(.files))
        #expect(handled == ["workspace:newTask", "terminal:back", "thread:copyThreadReference", "workspace:back"])
    }

    @Test
    func refreshingUnderlyingScopeDoesNotStealPrecedenceFromTheVisibleSheet() {
        let dispatcher = FeatureKeyboardDispatcher()
        let underlying = UUID()
        let sheet = UUID()
        var handled = ""
        dispatcher.updateScope(id: underlying, context: .init(enabledCommands: [.back])) { _ in handled = "old" }
        dispatcher.updateScope(id: sheet, context: .init(enabledCommands: [.back])) { _ in handled = "sheet" }
        dispatcher.updateScope(id: underlying, context: .init(enabledCommands: [.back])) { _ in handled = "refreshed" }
        #expect(dispatcher.perform(.back))
        #expect(handled == "sheet")
        dispatcher.removeScope(id: sheet)
        #expect(dispatcher.perform(.back))
        #expect(handled == "refreshed")
    }

    @Test
    func paletteRanksTitlesWithoutChangingRecentThreadTieOrder() {
        let content = FeatureCommandPaletteContent(items: [
            .init(id: "a", kind: .thread, title: "Older title", searchTerms: ["fix"]) {},
            .init(id: "b", kind: .thread, title: "Another title", searchTerms: ["fix"]) {},
            .init(id: "c", kind: .thread, title: "Fix keyboard") {},
            .init(id: "d", kind: .thread, title: "Fix") {},
            .init(id: "p", kind: .project, title: "Fix project") {},
        ])
        #expect(FeatureCommandPaletteSearch.results(in: content, query: "FIX").map(\.id) == ["d", "c", "p", "a", "b"])
        #expect(FeatureCommandPaletteSearch.results(in: content, query: "").map(\.id) == ["a", "b", "c", "d"])
    }

    @Test
    func paletteContentMatchesAreEnvironmentScopedAndActionsOnlyExcludeThreads() {
        let content = FeatureCommandPaletteContent(
            items: [
                .init(id: "files", title: "Open Files", searchTerms: ["browse", "repository"]) {},
                .init(id: "env-a/thread", kind: .thread, title: "First") {},
                .init(id: "env-b/thread", kind: .thread, title: "Second") {},
            ],
            matchedThreadIDs: ["env-b/thread"]
        )
        #expect(FeatureCommandPaletteSearch.results(in: content, query: "message text").map(\.id) == ["env-b/thread"])
        #expect(FeatureCommandPaletteSearch.results(in: content, query: ">browse repository").map(\.id) == ["files"])
        #expect(FeatureCommandPaletteSearch.results(in: content, query: ">message text").isEmpty)
        #expect(FeatureCommandPaletteSearch.nextIndex(0, direction: -1, count: 3) == 2)
        #expect(FeatureCommandPaletteSearch.nextIndex(2, direction: 1, count: 3) == 0)
        #expect(FeatureCommandPaletteSearch.nextIndex(0, direction: -1, count: 0) == 0)
    }

    @Test
    func actionModeStopsRemoteThreadSearch() {
        let dispatcher = FeatureKeyboardDispatcher()
        var queries: [String] = []
        dispatcher.update(
            context: .init(),
            paletteContent: { .init() },
            onPaletteQueryChange: { queries.append($0) },
            onCommand: { _ in }
        )
        dispatcher.search("message text")
        dispatcher.search(">settings")
        #expect(queries == ["message text", ""])
    }
}

@MainActor
private final class KeyboardTestPresenter: UIViewController {
    var modal: UIViewController?
    override var presentedViewController: UIViewController? { modal }
}

@MainActor
private final class KeyboardTestTable: UITableView {
    private(set) var reloadCount = 0
    private(set) var scrolledRows: [Int] = []

    override func reloadData() {
        reloadCount += 1
        super.reloadData()
    }

    override func scrollToRow(at indexPath: IndexPath, at scrollPosition: UITableView.ScrollPosition, animated: Bool) {
        scrolledRows.append(indexPath.row)
    }
}
