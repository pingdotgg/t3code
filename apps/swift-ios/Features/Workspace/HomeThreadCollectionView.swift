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
    let hapticsEnabled: Bool
    let settings: FeatureSettings
    let pullRequestsByThreadID: [String: HomeThreadPullRequestPresentation]
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
    let onSettle: (FeatureThread, Bool, @escaping (Bool) -> Void) -> Void
    let onSnooze: (FeatureThread, Date?) -> Void
    let onPin: (FeatureThread, Bool) -> Void
    let onDelete: (FeatureThread) -> Void
    let onPullRequestChange: (String, String, HomeThreadPullRequestPresentation?) -> Void

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
        coordinator.cancelPendingSwipeActions()
        collectionView.delegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDelegate {
        private enum Section: Hashable {
            case main
        }

        private struct PendingSwipeCompletion {
            let id: UUID
            let settled: Bool
            let finish: (Bool) -> Void
        }

        private var parent: HomeThreadCollectionView
        private var dataSource: UICollectionViewDiffableDataSource<Section, HomeCollectionItem.ID>?
        private var registration: UICollectionView.CellRegistration<HomeCollectionCell, HomeCollectionItem.ID>?
        private var itemsByID: [HomeCollectionItem.ID: HomeCollectionItem] = [:]
        private var threadItemIDs: [String: HomeCollectionItem.ID] = [:]
        private var pullRequestsByThreadID: [String: HomeThreadPullRequestPresentation] = [:]
        private var selectedThreadID: String?
        private weak var collectionView: UICollectionView?
        private var timer: Timer?
        private var timerTick = 0
        private var timerInterval: TimeInterval = 0
        private var pendingSwipeCompletions: [String: PendingSwipeCompletion] = [:]
        private var isApplyingSnapshot = false
        private var hasQueuedUpdate = false

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
            self.parent = parent
            hasQueuedUpdate = true
            applyLatestSnapshot(in: collectionView)
        }

        /// Keep a row's content and size fixed during its removal. Stream updates
        /// that arrive mid-animation are applied together after that animation.
        private func applyLatestSnapshot(in collectionView: UICollectionView) {
            guard !isApplyingSnapshot, hasQueuedUpdate, let dataSource else { return }
            hasQueuedUpdate = false
            let previousItems = itemsByID
            let previousThreadItemIDs = threadItemIDs
            let previousSelection = selectedThreadID
            selectedThreadID = parent.selectedThreadID

            var seenIdentifiers = Set<HomeCollectionItem.ID>()
            var seenThreadIDs = Set<String>()
            let items = parent.collectionItems.filter { item in
                if let threadID = item.id.threadID, !seenThreadIDs.insert(threadID).inserted {
                    return false
                }
                return seenIdentifiers.insert(item.id).inserted
            }
            itemsByID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
            threadItemIDs = Dictionary(uniqueKeysWithValues: items.compactMap { item in
                item.id.threadID.map { ($0, item.id) }
            })
            pullRequestsByThreadID = pullRequestsByThreadID.filter {
                threadItemIDs[$0.key] != nil
            }
            // After items land: picks 1 Hz when a working thread is present,
            // 60s otherwise, and is a no-op when the interval is unchanged.
            startTimer()

            let currentIdentifiers = dataSource.snapshot().itemIdentifiers
            let newIdentifiers = items.map(\.id)
            let resolvedSwipes = pendingSwipeCompletions.filter { threadID, pending in
                guard let identifier = threadItemIDs[threadID],
                      case let .thread(thread, _, _, _, _, _) = itemsByID[identifier] else {
                    return true
                }
                return thread.isEffectivelySettled() == pending.settled
            }
            let finishUpdate = { [weak self, weak collectionView] in
                guard let self else { return }
                for (threadID, pending) in resolvedSwipes {
                    guard self.pendingSwipeCompletions[threadID]?.id == pending.id else { continue }
                    self.pendingSwipeCompletions.removeValue(forKey: threadID)?.finish(true)
                }
                self.isApplyingSnapshot = false
                guard let collectionView else { return }
                self.synchronizeSelection(in: collectionView)
                self.applyLatestSnapshot(in: collectionView)
            }

            if currentIdentifiers == newIdentifiers {
                let changed = newIdentifiers.filter { previousItems[$0] != itemsByID[$0] }
                let selectionChanged = (previousSelection != selectedThreadID
                    ? [previousSelection, selectedThreadID] : [])
                    .compactMap { $0.flatMap { threadItemIDs[$0] } }
                let identifiers = Array(Set(changed + selectionChanged))
                if !identifiers.isEmpty {
                    var snapshot = dataSource.snapshot()
                    snapshot.reconfigureItems(identifiers)
                    isApplyingSnapshot = true
                    dataSource.apply(
                        snapshot,
                        animatingDifferences: false,
                        completion: finishUpdate
                    )
                } else {
                    finishUpdate()
                }
            } else {
                var snapshot = NSDiffableDataSourceSnapshot<Section, HomeCollectionItem.ID>()
                snapshot.appendSections([.main])
                snapshot.appendItems(newIdentifiers, toSection: .main)
                // Retained rows also need fresh content when another row moves,
                // arrives, or leaves in the same update.
                let retained = Set(currentIdentifiers)
                let selectionChanged = previousSelection != selectedThreadID
                    ? Set([previousSelection, selectedThreadID].compactMap { $0 }) : []
                snapshot.reconfigureItems(newIdentifiers.filter { identifier in
                    retained.contains(identifier)
                        && (previousItems[identifier] != itemsByID[identifier]
                            || identifier.threadID.map(selectionChanged.contains) == true)
                })
                let shouldAnimate = !resolvedSwipes.isEmpty
                    && !currentIdentifiers.isEmpty
                    && collectionView.window != nil
                    && !UIAccessibility.isReduceMotionEnabled
                if shouldAnimate {
                    for threadID in resolvedSwipes.keys {
                        guard let identifier = previousThreadItemIDs[threadID],
                              identifier != threadItemIDs[threadID],
                              let indexPath = dataSource.indexPath(for: identifier),
                              let cell = collectionView.cellForItem(at: indexPath) else { continue }
                        // UIKit fades deleted cells while their neighbors move up.
                        // Hide the departed text so it cannot show through those rows.
                        // The native swipe action view is outside contentView.
                        cell.contentView.isHidden = true
                    }
                }
                isApplyingSnapshot = true
                dataSource.apply(
                    snapshot,
                    animatingDifferences: shouldAnimate,
                    completion: finishUpdate
                )
            }

            synchronizeSelection(in: collectionView)
        }

        func invalidateTimer() {
            timer?.invalidate()
            timer = nil
        }

        func cancelPendingSwipeActions() {
            hasQueuedUpdate = false
            pendingSwipeCompletions.values.forEach { $0.finish(false) }
            pendingSwipeCompletions.removeAll()
        }

        func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
            guard let item = item(at: indexPath) else { return }
            switch item {
            case let .thread(thread, _, _, _, _, _):
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
            guard case let .thread(thread, _, _, isArchived, _, _) = item(at: indexPath) else {
                return nil
            }

            return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
                guard let self else { return nil }
                return UIMenu(children: self.menuActions(for: thread, isArchived: isArchived))
            }
        }

        func trailingSwipeActions(at indexPath: IndexPath) -> UISwipeActionsConfiguration? {
            guard case let .thread(thread, _, _, isArchived, _, _) = item(at: indexPath) else {
                return nil
            }

            let actions = HomeThreadSwipeAction
                .trailingActions(
                    for: thread,
                    isArchived: isArchived,
                    at: .now
                )
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
                guard let self else {
                    finish(false)
                    return
                }
                self.performSwipe(action, for: thread, finish: finish)
            }
            contextualAction.image = UIImage(systemName: action.systemImage)
            if let backgroundColor = action.backgroundColor {
                contextualAction.backgroundColor = backgroundColor
            }
            return contextualAction
        }

        func performSwipe(
            _ action: HomeThreadSwipeAction,
            for thread: FeatureThread,
            finish: @escaping (Bool) -> Void
        ) {
            if case let .setSettled(settled) = action.intent {
                guard pendingSwipeCompletions[thread.id] == nil else {
                    finish(false)
                    return
                }
                let completionID = UUID()
                pendingSwipeCompletions[thread.id] = PendingSwipeCompletion(
                    id: completionID,
                    settled: settled,
                    finish: finish
                )
                PlatformHapticEngine.shared.selection(enabled: parent.hapticsEnabled)
                parent.onSettle(thread, settled) { [weak self] succeeded in
                    guard !succeeded,
                          let self,
                          self.pendingSwipeCompletions[thread.id]?.id == completionID else {
                        return
                    }
                    self.pendingSwipeCompletions.removeValue(forKey: thread.id)?.finish(false)
                }
            } else {
                perform(action.intent, for: thread)
                finish(true)
            }
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
                parent.onSettle(thread, settled) { _ in }
            }
        }

        private func configure(
            _ cell: HomeCollectionCell,
            identifier: HomeCollectionItem.ID,
            now: Date
        ) {
            guard let item = itemsByID[identifier] else { return }
            cell.contentView.isHidden = false
            let pullRequestObservationIdentity: String?
            if case let .thread(thread, _, _, _, _, _) = item {
                pullRequestObservationIdentity = thread.pullRequestObservationIdentity
            } else {
                pullRequestObservationIdentity = nil
            }
            cell.contentConfiguration = UIHostingConfiguration {
                HomeCollectionCellContent(
                    item: item,
                    projectFaviconClient: parent.projectFaviconClient,
                    isSelected: identifier.threadID == selectedThreadID,
                    now: now,
                    onPullRequestChange: { [weak self, weak cell] pullRequest in
                        guard let self,
                              let cell,
                              let threadID = identifier.threadID else {
                            return
                        }
                        self.updatePullRequestAccessibility(
                            pullRequest,
                            threadID: threadID,
                            cell: cell
                        )
                        if let observationIdentity = pullRequestObservationIdentity {
                            self.parent.onPullRequestChange(
                                threadID,
                                observationIdentity,
                                pullRequest
                            )
                        }
                    }
                )
            }
            .margins(.all, 0)

            cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
            cell.accessories = []
            cell.tintColor = T3Colors.uiTextPrimary
            cell.clipsToBounds = true
            cell.contentView.clipsToBounds = true
            cell.contentView.accessibilityElementsHidden = true
            configureAccessibility(cell, item: item)
        }

        private func configureAccessibility(_ cell: HomeCollectionCell, item: HomeCollectionItem) {
            cell.accessibilityCustomActions = nil
            switch item {
            case let .thread(thread, context, _, isArchived, _, _):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = selectedThreadID == thread.id
                    ? [.button, .selected]
                    : .button
                cell.accessibilityLabel = thread.title
                cell.accessibilityValue = threadAccessibilityValue(thread, context: context)
                cell.accessibilityHint = "Opens thread. More actions are available."
                cell.accessibilityCustomActions = threadAccessibilityActions(
                    for: thread,
                    isArchived: isArchived
                )
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
                cell.accessibilityLabel = "\(shelf.title), \(count) \(count == 1 ? "task" : "tasks")"
                cell.accessibilityValue = isExpanded ? "Expanded" : "Collapsed"
                cell.accessibilityHint = isExpanded ? "Collapses the task list" : "Expands the task list"
                cell.onAccessibilityActivate = { [weak self] in self?.toggle(shelf) }
            case let .showMoreSettled(remaining):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = .button
                cell.accessibilityLabel = "Show \(remaining) more settled \(remaining == 1 ? "task" : "tasks")"
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
            var status = thread.homeStatusLabel ?? "Ready"
            if let duration = thread.homeWorkingDuration(at: .now) {
                status += " for \(duration)"
            }
            var values = [status, "Project \(context.projectName)"]
            if let pullRequest = pullRequestsByThreadID[thread.id] {
                values.append(pullRequest.accessibilityLabel)
            }
            if thread.pinnedAt != nil {
                values.append("Pinned")
            }
            if thread.isArchived {
                values.append("Archived")
            } else if thread.isEffectivelySnoozed(at: .now) {
                values.append("Snoozed")
            } else if thread.isEffectivelySettled() {
                values.append("Settled")
            }
            values.append("Provider \(context.providerName)")
            if let environment = context.environmentLabel {
                values.append("on \(environment)")
            }
            return values.joined(separator: ". ")
        }

        private func updatePullRequestAccessibility(
            _ pullRequest: HomeThreadPullRequestPresentation?,
            threadID: String,
            cell: HomeCollectionCell
        ) {
            guard let identifier = threadItemIDs[threadID],
                  case let .thread(thread, context, _, _, _, _) = itemsByID[identifier],
                  let indexPath = dataSource?.indexPath(for: identifier),
                  collectionView?.cellForItem(at: indexPath) === cell else {
                return
            }
            if let pullRequest {
                pullRequestsByThreadID[threadID] = pullRequest
            } else {
                pullRequestsByThreadID.removeValue(forKey: threadID)
            }
            cell.accessibilityValue = threadAccessibilityValue(thread, context: context)
        }

        private func threadAccessibilityActions(
            for thread: FeatureThread,
            isArchived: Bool
        ) -> [UIAccessibilityCustomAction] {
            var actions = [accessibilityAction("Rename", systemImage: "pencil") { coordinator in
                coordinator.parent.onRename(thread)
            }]

            if thread.supportsTitleRegeneration == true {
                actions.append(accessibilityAction("Regenerate title", systemImage: "sparkles") { coordinator in
                    coordinator.parent.onRegenerateTitle(thread)
                })
            }

            if !isArchived {
                if thread.canTogglePin {
                    let isPinned = thread.pinnedAt != nil
                    actions.append(accessibilityAction(
                        isPinned ? "Unpin" : "Pin",
                        systemImage: isPinned ? "pin.slash" : "pin"
                    ) { coordinator in
                        coordinator.parent.onPin(thread, !isPinned)
                    })
                }

                let isSettled = thread.isEffectivelySettled()
                if isSettled || thread.canSettleNow() {
                    actions.append(accessibilityAction(
                        isSettled ? "Reopen" : "Settle",
                        systemImage: isSettled ? "arrow.counterclockwise" : "checkmark"
                    ) { coordinator in
                        coordinator.parent.onSettle(thread, !isSettled) { _ in }
                    })
                }

                if thread.canToggleSnooze {
                    if thread.isEffectivelySnoozed(at: .now) {
                        actions.append(accessibilityAction("Wake", systemImage: "bell") { coordinator in
                            coordinator.parent.onSnooze(thread, nil)
                        })
                    } else if thread.state != .queued,
                              thread.state != .waitingForApproval,
                              thread.state != .waitingForInput {
                        actions.append(contentsOf: DailyUXSnoozePresets.resolve(now: .now).map { preset in
                            accessibilityAction("Snooze: \(preset.label)", systemImage: "clock") { coordinator in
                                coordinator.parent.onSnooze(thread, preset.until)
                            }
                        })
                    }
                }
            }

            actions.append(accessibilityAction(
                isArchived ? "Restore" : "Archive",
                systemImage: isArchived ? "arrow.uturn.backward" : "archivebox"
            ) { coordinator in
                coordinator.parent.onArchive(thread, !isArchived)
            })
            actions.append(accessibilityAction("Delete thread", systemImage: "trash") { coordinator in
                coordinator.parent.onDelete(thread)
            })
            return actions
        }

        private func accessibilityAction(
            _ title: String,
            systemImage: String,
            perform: @escaping (Coordinator) -> Void
        ) -> UIAccessibilityCustomAction {
            UIAccessibilityCustomAction(name: title, image: UIImage(systemName: systemImage)) { [weak self] _ in
                guard let self else { return false }
                perform(self)
                return true
            }
        }

        private func synchronizeSelection(in collectionView: UICollectionView) {
            for indexPath in collectionView.indexPathsForSelectedItems ?? [] {
                guard dataSource?.itemIdentifier(for: indexPath)?.threadID != selectedThreadID else {
                    continue
                }
                collectionView.deselectItem(at: indexPath, animated: false)
            }
            guard let selectedThreadID,
                  let identifier = threadItemIDs[selectedThreadID],
                  let indexPath = dataSource?.indexPath(for: identifier),
                  !collectionView.indexPathsForSelectedItems.orEmpty.contains(indexPath) else {
                return
            }
            collectionView.selectItem(at: indexPath, animated: false, scrollPosition: [])
        }

        private func refreshSelection(in collectionView: UICollectionView, ids: [String]) {
            for id in ids {
                guard let identifier = threadItemIDs[id],
                      let indexPath = dataSource?.indexPath(for: identifier),
                      let cell = collectionView.cellForItem(at: indexPath) as? HomeCollectionCell else {
                    continue
                }
                configure(cell, identifier: identifier, now: .now)
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

            var titleActions: [UIMenuElement] = [rename]
            if thread.supportsTitleRegeneration == true {
                titleActions.append(
                    UIAction(
                        title: "Regenerate title",
                        image: UIImage(systemName: "sparkles")
                    ) { [weak self] _ in
                        self?.parent.onRegenerateTitle(thread)
                    }
                )
            }

            var statusActions: [UIMenuElement] = []
            if !isArchived {
                if thread.canTogglePin {
                    let isPinned = thread.pinnedAt != nil
                    statusActions.append(
                        UIAction(
                            title: isPinned ? "Unpin" : "Pin",
                            image: UIImage(systemName: isPinned ? "pin.slash" : "pin")
                        ) { [weak self] _ in
                            self?.parent.onPin(thread, !isPinned)
                        }
                    )
                }
                let isSettled = thread.isEffectivelySettled()
                if isSettled || thread.canSettleNow() {
                    statusActions.append(
                        UIAction(
                            title: isSettled ? "Reopen" : "Settle",
                            image: UIImage(
                                systemName: isSettled ? "arrow.counterclockwise" : "checkmark"
                            )
                        ) { [weak self] _ in
                            self?.parent.onSettle(thread, !isSettled) { _ in }
                        }
                    )
                }

                if thread.canToggleSnooze {
                    let isSnoozed = thread.isEffectivelySnoozed(at: .now)
                    if isSnoozed {
                        statusActions.append(
                            UIAction(title: "Wake", image: UIImage(systemName: "bell")) {
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
                        statusActions.append(snooze)
                    }
                }
            }

            let archive = UIAction(
                title: isArchived ? "Restore" : "Archive",
                image: UIImage(systemName: isArchived ? "arrow.uturn.backward" : "archivebox")
            ) { [weak self] _ in
                self?.parent.onArchive(thread, !isArchived)
            }
            let delete = UIAction(
                title: "Delete thread",
                image: UIImage(systemName: "trash"),
                attributes: .destructive
            ) { [weak self] _ in
                self?.parent.onDelete(thread)
            }

            var sections = [UIMenu(options: .displayInline, children: titleActions)]
            if !statusActions.isEmpty {
                sections.append(UIMenu(options: .displayInline, children: statusActions))
            }
            sections.append(UIMenu(options: .displayInline, children: [archive]))
            sections.append(UIMenu(options: .displayInline, children: [delete]))
            return sections
        }

        /// Working rows show a live per-second duration, so they need a 1 Hz
        /// tick. Without any, relative ages only change by the minute, and the
        /// timer idles down to match instead of waking the main thread every
        /// second for the lifetime of the sidebar.
        private func startTimer() {
            let interval: TimeInterval = itemsByID.values.contains {
                if case let .thread(thread, _, _, _, _, _) = $0 {
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
            guard !isApplyingSnapshot,
                  let collectionView, let dataSource,
                  !collectionView.isTracking, !collectionView.isDecelerating else { return }
            timerTick = (timerTick + 1) % 60
            let refreshRelativeAges = timerInterval >= 60 || timerTick == 0
            let now = Date.now

            for indexPath in collectionView.indexPathsForVisibleItems {
                guard let identifier = dataSource.itemIdentifier(for: indexPath),
                      case let .thread(thread, _, _, _, _, _) = itemsByID[identifier],
                      refreshRelativeAges || thread.homeStatus == .working,
                      let cell = collectionView.cellForItem(at: indexPath) as? HomeCollectionCell else {
                    continue
                }
                configure(cell, identifier: identifier, now: now)
            }
        }
    }

    var collectionItems: [HomeCollectionItem] {
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
                    forceRichRows,
                    nil
                )
            }
        }

        var items = presentation.pinned.map {
            HomeCollectionItem.thread(
                $0,
                presentation.rowContexts[$0.id] ?? .fallback,
                .rich,
                false,
                forceRichRows,
                .active
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
                    forceRichRows,
                    .active
                )
            })
        }

        if !presentation.snoozed.isEmpty {
            items.append(.shelfHeader(.snoozed, presentation.snoozed.count, isSnoozedExpanded))
            if isSnoozedExpanded {
                items.append(contentsOf: presentation.snoozed.map {
                    .thread(
                        $0,
                        presentation.rowContexts[$0.id] ?? .fallback,
                        forceRichRows ? .rich : .slim,
                        false,
                        forceRichRows,
                        .snoozed
                    )
                })
            }
        }

        if !presentation.settled.isEmpty {
            items.append(.shelfHeader(.settled, presentation.settled.count, isSettledExpanded))
            if isSettledExpanded {
                items.append(contentsOf: presentation.settled.prefix(settledLimit).map {
                    .thread(
                        $0,
                        presentation.rowContexts[$0.id] ?? .fallback,
                        forceRichRows ? .rich : .slim,
                        false,
                        forceRichRows,
                        .settled
                    )
                })
                if presentation.settled.count > settledLimit {
                    items.append(.showMoreSettled(presentation.settled.count - settledLimit))
                }
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
                        forceRichRows,
                        .archived
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

        let isSettled = thread.isEffectivelySettled()
        let settlement: HomeThreadSwipeAction? = isSettled
            ? .reopen
            : (thread.canSettleNow(at: now) ? .settle : nil)
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
        contentView.isHidden = false
        onAccessibilityActivate = nil
    }
}

enum HomeShelf: String, Hashable {
    case active
    case snoozed
    case settled
    case archived

    var title: String {
        rawValue.capitalized
    }
}

enum HomeCollectionItem: Equatable {
    enum ID: Hashable {
        // A shelf change replaces the cell. Moving the same cell while it
        // changes between rich and slim layouts makes its height jump mid-swipe.
        case thread(String, HomeShelf?)
        case shelfHeader(HomeShelf)
        case empty(HomeShelf)
        case showMoreSettled
        case searchEmpty
        case pinnedDivider

        var threadID: String? {
            guard case let .thread(id, _) = self else { return nil }
            return id
        }
    }

    case thread(FeatureThread, HomeThreadRowContext, FeatureThreadRow.Style, Bool, Bool, HomeShelf?)
    case shelfHeader(HomeShelf, Int, Bool)
    case empty(HomeShelf)
    case showMoreSettled(Int)
    case searchEmpty(String)
    case pinnedDivider

    var id: ID {
        switch self {
        case let .thread(thread, _, _, _, _, shelf): .thread(thread.id, shelf)
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
    let onPullRequestChange: (HomeThreadPullRequestPresentation?) -> Void

    @ViewBuilder
    var body: some View {
        switch item {
        case let .thread(thread, context, style, _, allowsMultilineTitle, _):
            FeatureThreadRow(
                thread: thread,
                context: context,
                projectFaviconClient: projectFaviconClient,
                onPullRequestChange: onPullRequestChange,
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
