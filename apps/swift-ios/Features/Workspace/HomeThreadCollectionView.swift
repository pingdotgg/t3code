import SwiftUI
import UIKit

/// A recycled, diffable Home surface. SwiftUI still owns the surrounding shell,
/// while UIKit keeps row creation and updates proportional to visible threads.
struct HomeThreadCollectionView: UIViewRepresentable {
    let presentation: HomePresentation
    let projectFaviconClient: any FeatureClient
    let query: String
    let selectedThreadID: String?
    let forceRichRows: Bool
    let isSnoozedExpanded: Bool
    let isSettledExpanded: Bool
    let isArchiveExpanded: Bool
    let settledLimit: Int
    let onOpen: (String) -> Void
    let onToggleSnoozed: () -> Void
    let onToggleSettled: () -> Void
    let onToggleArchive: () -> Void
    let onShowMoreSettled: () -> Void
    let onRename: (FeatureThread) -> Void
    let onRegenerateTitle: (FeatureThread) -> Void
    let onArchive: (FeatureThread, Bool) -> Void
    let onSettle: (FeatureThread, Bool) -> Void
    let onSnooze: (FeatureThread, Date?) -> Void
    let onPin: (FeatureThread, Bool) -> Void
    let onDelete: (FeatureThread) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UICollectionView {
        var configuration = UICollectionLayoutListConfiguration(appearance: .plain)
        configuration.backgroundColor = T3Colors.uiBackground
        configuration.showsSeparators = false
        configuration.headerMode = .none
        configuration.footerMode = .none
        configuration.trailingSwipeActionsConfigurationProvider = { [weak coordinator = context.coordinator] indexPath in
            coordinator?.trailingSwipeActions(at: indexPath)
        }

        let collectionView = UICollectionView(
            frame: .zero,
            collectionViewLayout: UICollectionViewCompositionalLayout.list(using: configuration)
        )
        collectionView.backgroundColor = T3Colors.uiBackground
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = .interactive
        collectionView.contentInset = UIEdgeInsets(top: 4, left: 0, bottom: 74, right: 0)
        collectionView.verticalScrollIndicatorInsets = UIEdgeInsets(top: 4, left: 0, bottom: 74, right: 0)
        collectionView.delegate = context.coordinator
        context.coordinator.configure(collectionView)
        return collectionView
    }

    func updateUIView(_ collectionView: UICollectionView, context: Context) {
        context.coordinator.update(parent: self, collectionView: collectionView)
    }

    static func dismantleUIView(_ collectionView: UICollectionView, coordinator: Coordinator) {
        coordinator.invalidateTimer()
        collectionView.delegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDelegate {
        private enum Section: Hashable {
            case main
        }

        private var parent: HomeThreadCollectionView
        private var dataSource: UICollectionViewDiffableDataSource<Section, HomeCollectionItem.ID>?
        private var registration: UICollectionView.CellRegistration<HomeCollectionCell, HomeCollectionItem.ID>?
        private var itemsByID: [HomeCollectionItem.ID: HomeCollectionItem] = [:]
        private var selectedThreadID: String?
        private weak var collectionView: UICollectionView?
        private var timer: Timer?
        private var timerTick = 0
        private var timerInterval: TimeInterval = 0

        init(parent: HomeThreadCollectionView) {
            self.parent = parent
            selectedThreadID = parent.selectedThreadID
        }

        func configure(_ collectionView: UICollectionView) {
            self.collectionView = collectionView

            let registration = UICollectionView.CellRegistration<HomeCollectionCell, HomeCollectionItem.ID> {
                [weak self] cell, _, identifier in
                self?.configure(cell, identifier: identifier, now: .now)
            }
            self.registration = registration

            dataSource = UICollectionViewDiffableDataSource<Section, HomeCollectionItem.ID>(
                collectionView: collectionView
            ) { [weak self] collectionView, indexPath, identifier in
                guard let self, let registration = self.registration else { return nil }
                return collectionView.dequeueConfiguredReusableCell(
                    using: registration,
                    for: indexPath,
                    item: identifier
                )
            }

            update(parent: parent, collectionView: collectionView)
        }

        func update(parent: HomeThreadCollectionView, collectionView: UICollectionView) {
            let previousItems = itemsByID
            let previousSelection = selectedThreadID
            self.parent = parent
            selectedThreadID = parent.selectedThreadID

            var seenIdentifiers = Set<HomeCollectionItem.ID>()
            let items = parent.collectionItems.filter { item in
                seenIdentifiers.insert(item.id).inserted
            }
            itemsByID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
            // After items land: picks 1 Hz when a working thread is present,
            // 60s otherwise, and is a no-op when the interval is unchanged.
            startTimer()

            guard let dataSource else { return }
            let currentIdentifiers = dataSource.snapshot().itemIdentifiers
            let newIdentifiers = items.map(\.id)

            if currentIdentifiers == newIdentifiers {
                let changed = newIdentifiers.filter { previousItems[$0] != itemsByID[$0] }
                let selectionChanged = [previousSelection, selectedThreadID]
                    .compactMap { $0.map(HomeCollectionItem.ID.thread) }
                    .filter { newIdentifiers.contains($0) }
                let identifiers = Array(Set(changed + selectionChanged))
                if !identifiers.isEmpty {
                    var snapshot = dataSource.snapshot()
                    snapshot.reconfigureItems(identifiers)
                    dataSource.apply(snapshot, animatingDifferences: false)
                }
            } else {
                var snapshot = NSDiffableDataSourceSnapshot<Section, HomeCollectionItem.ID>()
                snapshot.appendSections([.main])
                snapshot.appendItems(newIdentifiers, toSection: .main)
                dataSource.apply(snapshot, animatingDifferences: false)
            }

            synchronizeSelection(in: collectionView)
        }

        func invalidateTimer() {
            timer?.invalidate()
            timer = nil
        }

        func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
            guard let item = item(at: indexPath) else { return }
            switch item {
            case let .thread(thread, _, _, _, _):
                let previousSelection = selectedThreadID
                selectedThreadID = thread.id
                parent.onOpen(thread.id)
                refreshSelection(
                    in: collectionView,
                    ids: [previousSelection, thread.id].compactMap { $0 }
                )
            case let .shelfHeader(shelf, _, _):
                collectionView.deselectItem(at: indexPath, animated: false)
                toggle(shelf)
            case .showMoreSettled:
                collectionView.deselectItem(at: indexPath, animated: false)
                parent.onShowMoreSettled()
            case .empty, .searchEmpty, .pinnedDivider:
                collectionView.deselectItem(at: indexPath, animated: false)
            }
        }

        func collectionView(
            _ collectionView: UICollectionView,
            contextMenuConfigurationForItemAt indexPath: IndexPath,
            point: CGPoint
        ) -> UIContextMenuConfiguration? {
            guard case let .thread(thread, _, _, isArchived, _) = item(at: indexPath) else {
                return nil
            }

            return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
                guard let self else { return nil }
                return UIMenu(children: self.menuActions(for: thread, isArchived: isArchived))
            }
        }

        func trailingSwipeActions(at indexPath: IndexPath) -> UISwipeActionsConfiguration? {
            guard case let .thread(thread, _, _, isArchived, _) = item(at: indexPath) else {
                return nil
            }

            let actions = HomeThreadSwipeAction
                .trailingActions(for: thread, isArchived: isArchived, at: .now)
            let configuration = UISwipeActionsConfiguration(
                actions: actions.map { contextualAction($0, for: thread) }
            )
            // A full swipe runs the edge action, which is only ever settlement.
            // Delete can never reach that slot, so the gesture cannot destroy a
            // thread; rows with nothing to settle keep the full swipe disabled.
            configuration.performsFirstActionWithFullSwipe =
                HomeThreadSwipeAction.performsFullSwipe(with: actions)
            return configuration
        }

        private func contextualAction(
            _ action: HomeThreadSwipeAction,
            for thread: FeatureThread
        ) -> UIContextualAction {
            let contextualAction = UIContextualAction(
                style: action.style,
                title: action.title
            ) { [weak self] _, _, finish in
                self?.perform(action.intent, for: thread)
                finish(true)
            }
            contextualAction.image = UIImage(systemName: action.systemImage)
            if let backgroundColor = action.backgroundColor {
                contextualAction.backgroundColor = backgroundColor
            }
            return contextualAction
        }

        /// Swipe actions reuse the same closures the context menu does, so a
        /// settle from either surface takes the one real settlement path.
        private func perform(_ intent: HomeThreadSwipeAction.Intent, for thread: FeatureThread) {
            switch intent {
            case .delete:
                parent.onDelete(thread)
            case let .setArchived(archived):
                parent.onArchive(thread, archived)
            case let .setPinned(pinned):
                parent.onPin(thread, pinned)
            case let .setSettled(settled):
                parent.onSettle(thread, settled)
            }
        }

        private func configure(
            _ cell: HomeCollectionCell,
            identifier: HomeCollectionItem.ID,
            now: Date
        ) {
            guard let item = itemsByID[identifier] else { return }
            cell.contentConfiguration = UIHostingConfiguration {
                HomeCollectionCellContent(
                    item: item,
                    projectFaviconClient: parent.projectFaviconClient,
                    isSelected: identifier.threadID == selectedThreadID,
                    now: now
                )
            }
            .margins(.all, 0)

            cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
            cell.accessories = []
            cell.tintColor = T3Colors.uiTextPrimary
            cell.contentView.accessibilityElementsHidden = true
            configureAccessibility(cell, item: item)
        }

        private func configureAccessibility(_ cell: HomeCollectionCell, item: HomeCollectionItem) {
            switch item {
            case let .thread(thread, context, _, _, _):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = selectedThreadID == thread.id
                    ? [.button, .selected]
                    : .button
                cell.accessibilityLabel = thread.title
                cell.accessibilityValue = threadAccessibilityValue(thread, context: context)
                cell.accessibilityHint = "Opens task"
                cell.onAccessibilityActivate = { [weak self] in
                    guard let self else { return }
                    let previousSelection = self.selectedThreadID
                    self.selectedThreadID = thread.id
                    self.parent.onOpen(thread.id)
                    if let collectionView = self.collectionView {
                        self.refreshSelection(
                            in: collectionView,
                            ids: [previousSelection, thread.id].compactMap { $0 }
                        )
                    }
                }
            case let .shelfHeader(shelf, count, isExpanded):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = .button
                cell.accessibilityLabel = "\(shelf.title), \(count) tasks"
                cell.accessibilityValue = isExpanded ? "Expanded" : "Collapsed"
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = { [weak self] in self?.toggle(shelf) }
            case let .showMoreSettled(remaining):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = .button
                cell.accessibilityLabel = "Show \(remaining) more settled tasks"
                cell.accessibilityValue = nil
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = { [weak self] in
                    self?.parent.onShowMoreSettled()
                }
            case let .empty(shelf):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = .staticText
                cell.accessibilityLabel = shelf == .active ? "No active tasks" : "No \(shelf.title.lowercased()) tasks"
                cell.accessibilityValue = nil
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = nil
            case .searchEmpty:
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = .staticText
                cell.accessibilityLabel = "No matching tasks"
                cell.accessibilityValue = nil
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = nil
            case .pinnedDivider:
                cell.isAccessibilityElement = false
                cell.onAccessibilityActivate = nil
            }
        }

        private func threadAccessibilityValue(
            _ thread: FeatureThread,
            context: HomeThreadRowContext
        ) -> String {
            let status = thread.homeDoneAccessibilityLabel(at: .now)
                ?? thread.homeStatusLabel
                ?? "Ready"
            var values = [status, "Project \(context.projectName)"]
            values.append("Harness \(context.providerName)")
            if let duration = thread.homeWorkingDuration(at: .now) {
                values.append("for \(duration)")
            }
            if let environment = context.environmentLabel {
                values.append("on \(environment)")
            }
            return values.joined(separator: ". ")
        }

        private func synchronizeSelection(in collectionView: UICollectionView) {
            for indexPath in collectionView.indexPathsForSelectedItems ?? [] {
                guard dataSource?.itemIdentifier(for: indexPath)?.threadID != selectedThreadID else {
                    continue
                }
                collectionView.deselectItem(at: indexPath, animated: false)
            }
            guard let selectedThreadID,
                  let indexPath = dataSource?.indexPath(for: .thread(selectedThreadID)),
                  !collectionView.indexPathsForSelectedItems.orEmpty.contains(indexPath) else {
                return
            }
            collectionView.selectItem(at: indexPath, animated: false, scrollPosition: [])
        }

        private func refreshSelection(in collectionView: UICollectionView, ids: [String]) {
            for id in ids {
                guard let indexPath = dataSource?.indexPath(for: .thread(id)),
                      let cell = collectionView.cellForItem(at: indexPath) as? HomeCollectionCell else {
                    continue
                }
                configure(cell, identifier: .thread(id), now: .now)
            }
        }

        private func item(at indexPath: IndexPath) -> HomeCollectionItem? {
            guard let identifier = dataSource?.itemIdentifier(for: indexPath) else { return nil }
            return itemsByID[identifier]
        }

        private func toggle(_ shelf: HomeShelf) {
            switch shelf {
            case .snoozed: parent.onToggleSnoozed()
            case .settled: parent.onToggleSettled()
            case .archived: parent.onToggleArchive()
            case .active: break
            }
        }

        private func menuActions(for thread: FeatureThread, isArchived: Bool) -> [UIMenuElement] {
            let rename = UIAction(title: "Rename", image: UIImage(systemName: "pencil")) { [weak self] _ in
                self?.parent.onRename(thread)
            }
            let archive = UIAction(
                title: isArchived ? "Restore" : "Archive",
                image: UIImage(systemName: isArchived ? "arrow.uturn.backward" : "archivebox")
            ) { [weak self] _ in
                self?.parent.onArchive(thread, !isArchived)
            }

            var actions: [UIMenuElement] = [rename]
            if thread.supportsTitleRegeneration == true {
                actions.append(
                    UIAction(
                        title: "Regenerate title",
                        image: UIImage(systemName: "sparkles")
                    ) { [weak self] _ in
                        self?.parent.onRegenerateTitle(thread)
                    }
                )
            }
            actions.append(archive)
            if !isArchived {
                if thread.canTogglePin {
                    let isPinned = thread.pinnedAt != nil
                    actions.append(
                        UIAction(
                            title: isPinned ? "Unpin" : "Pin",
                            image: UIImage(systemName: isPinned ? "pin.slash" : "pin")
                        ) { [weak self] _ in
                            self?.parent.onPin(thread, !isPinned)
                        }
                    )
                }
                if thread.canToggleSettlement {
                    let isSettled = thread.isEffectivelySettled(at: .now)
                    actions.append(
                        UIAction(
                            title: isSettled ? "Reopen" : "Settle",
                            image: UIImage(
                                systemName: isSettled ? "arrow.counterclockwise" : "checkmark"
                            )
                        ) { [weak self] _ in
                            self?.parent.onSettle(thread, !isSettled)
                        }
                    )
                }

                if thread.canToggleSnooze {
                    let isSnoozed = thread.isEffectivelySnoozed(at: .now)
                    if isSnoozed {
                        actions.append(
                            UIAction(title: "Wake thread", image: UIImage(systemName: "bell")) {
                                [weak self] _ in
                                self?.parent.onSnooze(thread, nil)
                            }
                        )
                    } else {
                        let presets = DailyUXSnoozePresets.resolve(now: .now)
                        let children = presets.map { preset in
                            UIAction(title: preset.label) { [weak self] _ in
                                self?.parent.onSnooze(thread, preset.until)
                            }
                        }
                        let snoozeIsDisabled = thread.state == .queued
                            || thread.state == .waitingForApproval
                            || thread.state == .waitingForInput
                        if snoozeIsDisabled {
                            children.forEach { $0.attributes = .disabled }
                        }
                        let snooze = UIMenu(
                            title: "Snooze",
                            image: UIImage(systemName: "clock"),
                            children: children
                        )
                        actions.append(snooze)
                    }
                }
            }

            actions.append(
                UIAction(title: "Delete", image: UIImage(systemName: "trash"), attributes: .destructive) {
                    [weak self] _ in
                    self?.parent.onDelete(thread)
                }
            )
            return actions
        }

        /// Working rows show a live per-second duration, so they need a 1 Hz
        /// tick. Without any, relative ages only change by the minute, and the
        /// timer idles down to match instead of waking the main thread every
        /// second for the lifetime of the sidebar.
        private func startTimer() {
            let interval: TimeInterval = itemsByID.values.contains {
                if case let .thread(thread, _, _, _, _) = $0 {
                    return thread.homeStatus == .working
                }
                return false
            } ? 1 : 60

            if timer != nil, timerInterval == interval { return }
            invalidateTimer()
            timerInterval = interval
            timerTick = 0
            timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.refreshVisibleTimes()
                }
            }
            timer?.tolerance = interval * 0.12
        }

        private func refreshVisibleTimes() {
            guard let collectionView, let dataSource else { return }
            timerTick = (timerTick + 1) % 60
            let refreshRelativeAges = timerInterval >= 60 || timerTick == 0
            let now = Date.now

            for indexPath in collectionView.indexPathsForVisibleItems {
                guard let identifier = dataSource.itemIdentifier(for: indexPath),
                      case let .thread(thread, _, _, _, _) = itemsByID[identifier],
                      refreshRelativeAges || thread.homeStatus == .working,
                      let cell = collectionView.cellForItem(at: indexPath) as? HomeCollectionCell else {
                    continue
                }
                configure(cell, identifier: identifier, now: now)
            }
        }
    }

    private var collectionItems: [HomeCollectionItem] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedQuery.isEmpty {
            if presentation.searchResults.isEmpty {
                return [.searchEmpty(normalizedQuery)]
            }
            return presentation.searchResults.map {
                .thread(
                    $0,
                    presentation.rowContexts[$0.id] ?? .fallback,
                    .rich,
                    $0.isArchived,
                    forceRichRows
                )
            }
        }

        var items = presentation.pinned.map {
            HomeCollectionItem.thread(
                $0,
                presentation.rowContexts[$0.id] ?? .fallback,
                .rich,
                false,
                forceRichRows
            )
        }
        if !presentation.pinned.isEmpty, !presentation.active.isEmpty {
            items.append(.pinnedDivider)
        }
        if presentation.active.isEmpty, presentation.pinned.isEmpty {
            items.append(.empty(.active))
        } else {
            items.append(contentsOf: presentation.active.map {
                .thread(
                    $0,
                    presentation.rowContexts[$0.id] ?? .fallback,
                    .rich,
                    false,
                    forceRichRows
                )
            })
        }

        items.append(.shelfHeader(.snoozed, presentation.snoozed.count, isSnoozedExpanded))
        if isSnoozedExpanded {
            items.append(contentsOf: presentation.snoozed.isEmpty
                ? [.empty(.snoozed)]
                : presentation.snoozed.map {
                    .thread(
                        $0,
                        presentation.rowContexts[$0.id] ?? .fallback,
                        forceRichRows ? .rich : .slim,
                        false,
                        forceRichRows
                    )
                })
        }

        items.append(.shelfHeader(.settled, presentation.settled.count, isSettledExpanded))
        if isSettledExpanded {
            items.append(contentsOf: presentation.settled.prefix(settledLimit).map {
                .thread(
                    $0,
                    presentation.rowContexts[$0.id] ?? .fallback,
                    forceRichRows ? .rich : .slim,
                    false,
                    forceRichRows
                )
            })
            if presentation.settled.count > settledLimit {
                items.append(.showMoreSettled(presentation.settled.count - settledLimit))
            }
        }

        if !presentation.archived.isEmpty {
            items.append(.shelfHeader(.archived, presentation.archived.count, isArchiveExpanded))
            if isArchiveExpanded {
                items.append(contentsOf: presentation.archived.map {
                    .thread(
                        $0,
                        presentation.rowContexts[$0.id] ?? .fallback,
                        forceRichRows ? .rich : .slim,
                        true,
                        forceRichRows
                    )
                })
            }
        }
        return items
    }
}

/// The trailing swipe actions a Home row offers, resolved as data so the row's
/// gesture semantics stay deterministic and testable without hosting a
/// collection view. Order is outermost-first, matching
/// `UISwipeActionsConfiguration`, which lays trailing actions out from the
/// trailing edge inward and runs the first action on a full swipe.
enum HomeThreadSwipeAction: Equatable {
    case delete
    case restore
    case unpin
    case settle
    case reopen
    case archive

    /// The lifecycle mutation an action requests. Keeping it separate from the
    /// action keeps the swipe wiring verifiable and forces every case through
    /// the row's existing callbacks instead of a second settlement path.
    enum Intent: Equatable {
        case delete
        case setArchived(Bool)
        case setPinned(Bool)
        case setSettled(Bool)
    }

    /// Settlement owns the edge slot on every row that can settle, so a full
    /// swipe clears the task in one motion and a partial swipe still reveals
    /// every button. Delete is always last and therefore can never be the
    /// full-swipe action. A pinned row keeps Unpin between the two: settling
    /// already clears the pin, so the full swipe unpins and settles together.
    /// Archived rows stay restore-only, and a row with nothing to settle keeps
    /// its reversible action at the edge with the full swipe turned off.
    static func trailingActions(
        for thread: FeatureThread,
        isArchived: Bool,
        at now: Date
    ) -> [HomeThreadSwipeAction] {
        guard !isArchived else { return [.restore, .delete] }

        let settlement: HomeThreadSwipeAction? = thread.canToggleSettlement
            ? (thread.isEffectivelySettled(at: now) ? .reopen : .settle)
            : nil
        let isPinned = thread.pinnedAt != nil && thread.canTogglePin

        var actions: [HomeThreadSwipeAction] = []
        if let settlement {
            actions.append(settlement)
            if isPinned {
                actions.append(.unpin)
            }
        } else if isPinned {
            actions.append(.unpin)
        } else {
            actions.append(.archive)
        }
        actions.append(.delete)
        return actions
    }

    /// The full swipe is armed only when the edge action settles or reopens.
    /// Nothing else may run from the gesture alone.
    static func performsFullSwipe(with actions: [HomeThreadSwipeAction]) -> Bool {
        actions.first?.isSettlement ?? false
    }

    var isSettlement: Bool {
        self == .settle || self == .reopen
    }

    var intent: Intent {
        switch self {
        case .delete: .delete
        case .restore: .setArchived(false)
        case .archive: .setArchived(true)
        case .unpin: .setPinned(false)
        case .settle: .setSettled(true)
        case .reopen: .setSettled(false)
        }
    }

    var title: String {
        switch self {
        case .delete: "Delete"
        case .restore: "Restore"
        case .unpin: "Unpin"
        case .settle: "Settle"
        case .reopen: "Reopen"
        case .archive: "Archive"
        }
    }

    var systemImage: String {
        switch self {
        case .delete: "trash"
        case .restore: "arrow.uturn.backward"
        case .unpin: "pin.slash"
        case .settle: "checkmark"
        case .reopen: "arrow.counterclockwise"
        case .archive: "archivebox"
        }
    }

    var style: UIContextualAction.Style {
        self == .delete ? .destructive : .normal
    }

    /// Destructive actions keep UIKit's own tint.
    var backgroundColor: UIColor? {
        switch self {
        case .delete: nil
        case .restore, .unpin, .reopen: .systemBlue
        case .settle: .systemGreen
        case .archive: .systemGray
        }
    }
}

private final class HomeCollectionCell: UICollectionViewListCell {
    var onAccessibilityActivate: (() -> Void)?

    override func accessibilityActivate() -> Bool {
        guard let onAccessibilityActivate else { return super.accessibilityActivate() }
        onAccessibilityActivate()
        return true
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        onAccessibilityActivate = nil
    }
}

private enum HomeShelf: String, Hashable {
    case active
    case snoozed
    case settled
    case archived

    var title: String {
        rawValue.capitalized
    }
}

private enum HomeCollectionItem: Equatable {
    enum ID: Hashable {
        case thread(String)
        case shelfHeader(HomeShelf)
        case empty(HomeShelf)
        case showMoreSettled
        case searchEmpty
        case pinnedDivider

        var threadID: String? {
            guard case let .thread(id) = self else { return nil }
            return id
        }
    }

    case thread(FeatureThread, HomeThreadRowContext, FeatureThreadRow.Style, Bool, Bool)
    case shelfHeader(HomeShelf, Int, Bool)
    case empty(HomeShelf)
    case showMoreSettled(Int)
    case searchEmpty(String)
    case pinnedDivider

    var id: ID {
        switch self {
        case let .thread(thread, _, _, _, _): .thread(thread.id)
        case let .shelfHeader(shelf, _, _): .shelfHeader(shelf)
        case let .empty(shelf): .empty(shelf)
        case .showMoreSettled: .showMoreSettled
        case .searchEmpty: .searchEmpty
        case .pinnedDivider: .pinnedDivider
        }
    }
}

private struct HomeCollectionCellContent: View {
    let item: HomeCollectionItem
    let projectFaviconClient: any FeatureClient
    let isSelected: Bool
    let now: Date

    @ViewBuilder
    var body: some View {
        switch item {
        case let .thread(thread, context, style, _, allowsMultilineTitle):
            FeatureThreadRow(
                thread: thread,
                context: context,
                projectFaviconClient: projectFaviconClient,
                isSelected: isSelected,
                style: style,
                now: now,
                allowsMultilineTitle: allowsMultilineTitle
            )
        case let .shelfHeader(shelf, count, isExpanded):
            HomeShelfHeader(
                title: shelf.title,
                count: count,
                isExpanded: isExpanded,
                accent: shelf == .snoozed ? T3Colors.accent : nil
            )
        case let .empty(shelf):
            Text(shelf == .active ? "No active tasks" : "None")
                .font(T3Typography.homeMetadata)
                .foregroundStyle(T3Colors.textTertiary)
                .frame(maxWidth: .infinity, minHeight: shelf == .active ? 68 : 34, alignment: .center)
        case let .showMoreSettled(remaining):
            HStack {
                Text("Show more")
                Spacer()
                Text("\(remaining)")
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .font(T3Typography.homeMetadata.weight(.semibold))
            .foregroundStyle(T3Colors.textSecondary)
            .padding(.horizontal, 34)
            .frame(minHeight: T3Metrics.minimumTapTarget)
        case .searchEmpty:
            ContentUnavailableView("No matching tasks", systemImage: "magnifyingglass")
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, minHeight: 160)
        case .pinnedDivider:
            Rectangle()
                .fill(T3Colors.textTertiary.opacity(0.18))
                .frame(height: 1)
                .padding(.horizontal, 18)
                .padding(.vertical, 3)
        }
    }
}

private extension Optional where Wrapped == [IndexPath] {
    var orEmpty: [IndexPath] { self ?? [] }
}
