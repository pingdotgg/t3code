import UIKit

enum FeatureKeyboardCommand: Hashable {
    case commandPalette, newTask, focusSearch, back, files, terminal, review
    case copyThreadReference, toggleSidebar, cycleHost
    /// One-based position in the rendered thread list, including its filters.
    case threadJump(Int)

    var title: String {
        switch self {
        case .commandPalette: "Command Palette"
        case .newTask: "New Task"
        case .focusSearch: "Find"
        case .back: "Back"
        case .files: "Open Files"
        case .terminal: "Open Terminal"
        case .review: "Review Changes"
        case .copyThreadReference: "Copy PR Link or Thread ID"
        case .toggleSidebar: "Toggle Sidebar"
        case .cycleHost: "Next Computer"
        case .threadJump(let number): "Go to Thread \(number)"
        }
    }

    var id: String {
        switch self {
        case .commandPalette: "commandPalette"
        case .newTask: "newTask"
        case .focusSearch: "focusSearch"
        case .back: "back"
        case .files: "files"
        case .terminal: "terminal"
        case .review: "review"
        case .copyThreadReference: "copyThreadReference"
        case .toggleSidebar: "toggleSidebar"
        case .cycleHost: "cycleHost"
        case .threadJump(let number): "thread.jump.\(number)"
        }
    }

    static let paletteActions: [Self] = [
        .newTask, .focusSearch, .back, .files, .terminal, .review,
        .copyThreadReference, .toggleSidebar, .cycleHost,
    ]
}

/// Navigation owns availability and resolves commands against its current
/// environment/thread. A terminal must retain its copy shortcut.
struct FeatureKeyboardContext: Equatable {
    var enabledCommands: Set<FeatureKeyboardCommand> = [.commandPalette, .newTask]
    var isTerminalActive = false

    func allows(_ command: FeatureKeyboardCommand) -> Bool {
        if isTerminalActive && command == .copyThreadReference { return false }
        if case .threadJump(let number) = command, !(1...9).contains(number) { return false }
        return enabledCommands.contains(command)
    }
}

struct FeatureKeyboardShortcut {
    let command: FeatureKeyboardCommand
    let input: String
    let modifiers: UIKeyModifierFlags

    static func available(
        in context: FeatureKeyboardContext,
        isPad: Bool
    ) -> [Self] {
        var shortcuts: [Self] = [
            .init(command: .newTask, input: "n", modifiers: .command),
            .init(command: .focusSearch, input: "f", modifiers: .command),
            .init(command: isPad ? .commandPalette : .focusSearch, input: "k", modifiers: .command),
            .init(command: .back, input: "[", modifiers: .command),
            .init(command: .files, input: "f", modifiers: [.command, .shift]),
            .init(command: .terminal, input: "t", modifiers: [.command, .shift]),
            .init(command: .review, input: "r", modifiers: [.command, .shift]),
            .init(command: .copyThreadReference, input: "c", modifiers: [.command, .shift]),
            .init(command: .toggleSidebar, input: "\\", modifiers: .command),
            .init(command: .cycleHost, input: "h", modifiers: [.command, .shift]),
        ]
        if isPad {
            shortcuts += (1...9).map {
                .init(command: .threadJump($0), input: String($0), modifiers: .command)
            }
        }
        return shortcuts.filter { context.allows($0.command) }
    }
}

@MainActor
struct FeatureCommandPaletteItem: Identifiable {
    enum Kind { case action, project, thread }

    let id: String
    var kind: Kind = .action
    let title: String
    var detail: String? = nil
    var searchTerms: [String] = []
    let run: @MainActor () -> Void
}

/// Read only while the palette is visible. Match IDs must use the same
/// environment-scoped IDs as the corresponding thread items.
struct FeatureCommandPaletteContent {
    var items: [FeatureCommandPaletteItem] = []
    var matchedThreadIDs: Set<String> = []
    var isSearching = false
}

@MainActor
enum FeatureCommandPaletteSearch {
    static func results(
        in content: FeatureCommandPaletteContent,
        query: String
    ) -> [FeatureCommandPaletteItem] {
        let actionsOnly = query.hasPrefix(">")
        let normalized = (actionsOnly ? String(query.dropFirst()) : query)
            .trimmingCharacters(in: .whitespacesAndNewlines).localizedLowercase
        let tokens = normalized.split(whereSeparator: \.isWhitespace)
        return content.items.enumerated().compactMap { index, item -> (FeatureCommandPaletteItem, Int, Int)? in
            if actionsOnly && item.kind != .action { return nil }
            if normalized.isEmpty {
                return item.kind == .project ? nil : (item, 0, index)
            }
            let title = item.title.localizedLowercase
            let haystack = ([title] + item.searchTerms).joined(separator: " ").localizedLowercase
            guard tokens.allSatisfy({ haystack.contains($0) })
                || (item.kind == .thread && content.matchedThreadIDs.contains(item.id)) else { return nil }
            let rank = title == normalized ? 3 : title.hasPrefix(normalized) ? 2 : title.contains(normalized) ? 1 : 0
            return (item, rank, index)
        }.sorted {
            $0.1 == $1.1 ? $0.2 < $1.2 : $0.1 > $1.1
        }.map(\.0)
    }

    static func nextIndex(_ index: Int, direction: Int, count: Int) -> Int {
        guard count > 0 else { return 0 }
        return ((index + direction) % count + count) % count
    }
}

/// One dispatcher serves the visible keyboard commands and the palette.
/// Configure it from the navigation owner; it does not retain model IDs or
/// introduce another source of active-thread state.
@MainActor
final class FeatureKeyboardDispatcher {
    private struct Scope {
        let id: UUID
        var context: FeatureKeyboardContext
        var handler: (FeatureKeyboardCommand) -> Void
        var beforeRootAction: ((@escaping @MainActor () -> Void) -> Void)?
        weak var presenter: UIViewController?
    }

    private var rootContext = FeatureKeyboardContext()
    private var scopes: [Scope] = []
    private var handler: (FeatureKeyboardCommand) -> Void = { _ in }
    private var paletteContent: () -> FeatureCommandPaletteContent = { .init() }
    private var queryChanged: (String) -> Void = { _ in }
    var presentPalette: (() -> Void)?
    var dismissPalette: ((@escaping @MainActor () -> Void) -> Void)?

    /// Scopes in the same presentation can compose. A modal replaces the
    /// commands of the screen behind it, even when it has no local commands.
    private var activeScopes: [Scope] {
        let presentation = activePresenter.map(FeatureKeyboardPresentation.root)
        return scopes.filter { scope in
            scope.presenter.map(FeatureKeyboardPresentation.root) === presentation
        }
    }

    var context: FeatureKeyboardContext {
        var context = rootContext
        for scope in activeScopes { context.enabledCommands.formUnion(scope.context.enabledCommands) }
        context.isTerminalActive = activeScopes.last?.context.isTerminalActive ?? rootContext.isTerminalActive
        return context
    }

    var activePresenter: UIViewController? {
        // A background scope can register again after an app activation. Keep
        // commands with the visible presentation, regardless of registration order.
        scopes.last(where: { $0.presenter.map(FeatureKeyboardPresentation.isTop) == true })?.presenter
            ?? scopes.last?.presenter
    }

    func update(
        context: FeatureKeyboardContext,
        paletteContent: @escaping () -> FeatureCommandPaletteContent,
        onPaletteQueryChange: @escaping (String) -> Void = { _ in },
        onCommand: @escaping (FeatureKeyboardCommand) -> Void
    ) {
        rootContext = context
        self.paletteContent = paletteContent
        queryChanged = onPaletteQueryChange
        handler = onCommand
    }

    @discardableResult
    func perform(_ command: FeatureKeyboardCommand) -> Bool {
        if let activePresenter, !FeatureKeyboardPresentation.isTop(activePresenter) { return false }
        guard context.allows(command) else { return false }
        if command == .commandPalette {
            guard let presentPalette else { return false }
            presentPalette()
        } else if let scope = activeScopes.last(where: { $0.context.allows(command) }) {
            scope.handler(command)
        } else {
            performRootAction { [weak self] in self?.handler(command) }
        }
        return true
    }

    func content() -> FeatureCommandPaletteContent {
        var content = paletteContent()
        let customIDs = Set(content.items.map(\.id))
        content.items = content.items.map { item in
            FeatureCommandPaletteItem(id: item.id, kind: item.kind, title: item.title,
                detail: item.detail, searchTerms: item.searchTerms) { [weak self] in
                self?.performRootAction(item.run)
            }
        }
        let commands = FeatureKeyboardCommand.paletteActions.filter {
            context.allows($0) && !customIDs.contains($0.id)
        }
        content.items = commands.map { command in
            FeatureCommandPaletteItem(id: command.id, title: command.title) { [weak self] in
                self?.perform(command)
            }
        } + content.items
        return content
    }

    func search(_ query: String) {
        // RN's ">" mode only searches actions, never thread content.
        queryChanged(query.hasPrefix(">") ? "" : query)
    }

    /// Incoming routes also wait for the palette's UIKit dismissal completion.
    func afterDismissingPalette(_ action: @escaping @MainActor () -> Void) {
        if let dismissPalette { dismissPalette(action) }
        else { action() }
    }

    /// A presented tool finishes dismissal before Workspace changes routes.
    private func performRootAction(_ action: @escaping @MainActor () -> Void) {
        if let prepare = activeScopes.last?.beforeRootAction { prepare(action) }
        else { action() }
    }

    func updateScope(
        id: UUID,
        context: FeatureKeyboardContext,
        presenter: UIViewController? = nil,
        beforeRootAction: ((@escaping @MainActor () -> Void) -> Void)? = nil,
        onCommand: @escaping (FeatureKeyboardCommand) -> Void
    ) {
        let scope = Scope(id: id, context: context, handler: onCommand,
            beforeRootAction: beforeRootAction, presenter: presenter)
        if let index = scopes.firstIndex(where: { $0.id == id }) {
            scopes[index] = scope
        } else {
            scopes.append(scope)
        }
    }

    func removeScope(id: UUID) {
        scopes.removeAll { $0.id == id }
    }
}

@MainActor
enum FeatureKeyboardPresentation {
    static func root(_ controller: UIViewController) -> UIViewController {
        var root = controller
        while let parent = root.parent { root = parent }
        return root
    }

    static func isTop(_ controller: UIViewController) -> Bool {
        var ancestor: UIViewController? = controller
        while let current = ancestor {
            if current.presentedViewController != nil { return false }
            ancestor = current.parent
        }
        return true
    }
}
