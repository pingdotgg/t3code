import SwiftUI
import UIKit

/// A recycled, diffable Home surface. SwiftUI still owns the surrounding shell,
/// while UIKit keeps row creation and updates proportional to visible threads.
struct HomeThreadCollectionView: UIViewRepresentable {
    let presentation: HomePresentation
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
        configuration.backgroundColor = .black
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
        collectionView.backgroundColor = .black
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

            startTimer()
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

            let delete = UIContextualAction(style: .destructive, title: "Delete") { [weak self] _, _, finish in
                self?.parent.onDelete(thread)
                finish(true)
            }
            delete.image = UIImage(systemName: "trash")

            let primaryAction: UIContextualAction
            if isArchived {
                primaryAction = UIContextualAction(style: .normal, title: "Restore") {
                    [weak self] _, _, finish in
                    self?.parent.onArchive(thread, false)
                    finish(true)
                }
                primaryAction.image = UIImage(systemName: "arrow.uturn.backward")
                primaryAction.backgroundColor = .systemBlue
            } else if thread.pinnedAt != nil, thread.canTogglePin {
                primaryAction = UIContextualAction(style: .normal, title: "Unpin") {
                    [weak self] _, _, finish in
                    self?.parent.onPin(thread, false)
                    finish(true)
                }
                primaryAction.image = UIImage(systemName: "pin.slash")
                primaryAction.backgroundColor = .systemBlue
            } else {
                let isSettled = thread.isEffectivelySettled(at: .now)
                primaryAction = UIContextualAction(
                    style: .normal,
                    title: isSettled ? "Reopen" : "Settle"
                ) { [weak self] _, _, finish in
                    self?.parent.onSettle(thread, !isSettled)
                    finish(true)
                }
                primaryAction.image = UIImage(
                    systemName: isSettled ? "arrow.counterclockwise" : "checkmark"
                )
                primaryAction.backgroundColor = isSettled ? .systemBlue : .systemGreen
            }

            let configuration = UISwipeActionsConfiguration(actions: [delete, primaryAction])
            configuration.performsFirstActionWithFullSwipe = false
            return configuration
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
                    isSelected: identifier.threadID == selectedThreadID,
                    now: now
                )
            }
            .margins(.all, 0)

            cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
            cell.accessories = []
            cell.tintColor = .white
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
            var values = [thread.homeStatusLabel ?? "Ready", "Project \(context.projectName)"]
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

            var actions: [UIMenuElement] = [rename, archive]
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
                let isSettled = thread.isEffectivelySettled(at: .now)
                actions.append(
                    UIAction(
                        title: isSettled ? "Reopen" : "Settle",
                        image: UIImage(systemName: isSettled ? "arrow.counterclockwise" : "checkmark")
                    ) { [weak self] _ in
                        self?.parent.onSettle(thread, !isSettled)
                    }
                )

                let isSnoozed = thread.isEffectivelySnoozed(at: .now)
                let snooze = UIAction(
                    title: isSnoozed ? "Unsnooze" : "Snooze 1 hour",
                    image: UIImage(systemName: isSnoozed ? "bell" : "clock")
                ) { [weak self] _ in
                    self?.parent.onSnooze(
                        thread,
                        isSnoozed ? nil : Date.now.addingTimeInterval(60 * 60)
                    )
                }
                if thread.state == .queued
                    || thread.state == .waitingForApproval
                    || thread.state == .waitingForInput {
                    snooze.attributes = .disabled
                }
                actions.append(snooze)
            }

            actions.append(
                UIAction(title: "Delete", image: UIImage(systemName: "trash"), attributes: .destructive) {
                    [weak self] _ in
                    self?.parent.onDelete(thread)
                }
            )
            return actions
        }

        private func startTimer() {
            invalidateTimer()
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.refreshVisibleTimes()
                }
            }
            timer?.tolerance = 0.12
        }

        private func refreshVisibleTimes() {
            guard let collectionView, let dataSource else { return }
            timerTick = (timerTick + 1) % 60
            let refreshRelativeAges = timerTick == 0
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
    let isSelected: Bool
    let now: Date

    @ViewBuilder
    var body: some View {
        switch item {
        case let .thread(thread, context, style, _, allowsMultilineTitle):
            FeatureThreadRow(
                thread: thread,
                context: context,
                isSelected: isSelected,
                style: style,
                now: now,
                allowsMultilineTitle: allowsMultilineTitle
            )
            .equatable()
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
