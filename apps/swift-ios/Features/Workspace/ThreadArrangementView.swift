import SwiftUI
import UIKit

/// Lives on the workspace, not a row, so moving the source to another shelf
/// does not dismiss the sheet.
struct ThreadArrangementView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    @State private var action: String?
    @State private var now = Date.now

    var body: some View {
        NavigationStack {
            ThreadArrangementCollection(
                model: model,
                revision: model.homePresentationRevision,
                busy: model.isArrangingThreads,
                now: now,
                onAction: { action = $0 }
            )
            .background(.black)
            .navigationTitle(action ?? "Arrange threads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .disabled(model.isArrangingThreads)
                }
            }
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(model.isArrangingThreads)
        .alert("Could not arrange threads", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "The move failed.")
        }
        .task(id: nextWake) {
            guard let wake = nextWake else { return }
            do {
                try await Task.sleep(for: .seconds(max(0, wake.timeIntervalSinceNow)))
                now = max(.now, wake)
            } catch {}
        }
    }

    private var nextWake: Date? {
        model.snapshot.threads.compactMap(\.snoozedUntil).filter { $0 > now }.min()
    }
}

private struct ThreadArrangementCollection: UIViewRepresentable {
    let model: FeatureRootModel
    let revision: UInt64
    let busy: Bool
    let now: Date
    let onAction: (String?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> UICollectionView {
        var layout = UICollectionLayoutListConfiguration(appearance: .plain)
        layout.backgroundColor = .black
        layout.showsSeparators = false
        let view = UICollectionView(
            frame: .zero,
            collectionViewLayout: UICollectionViewCompositionalLayout.list(using: layout)
        )
        view.backgroundColor = .black
        view.alwaysBounceVertical = true
        view.dragInteractionEnabled = true
        view.delegate = context.coordinator
        view.dragDelegate = context.coordinator
        view.dropDelegate = context.coordinator
        context.coordinator.configure(view)
        return view
    }

    func updateUIView(_ view: UICollectionView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.update()
    }

    static func dismantleUIView(_ view: UICollectionView, coordinator: Coordinator) {
        view.delegate = nil
        view.dragDelegate = nil
        view.dropDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDelegate,
        UICollectionViewDragDelegate, UICollectionViewDropDelegate {
        struct Row {
            let section: ThreadArrangementSection
            var thread: FeatureThread?
            var id: String { thread.map { "thread:\($0.id)" } ?? "section:\(section.rawValue)" }
        }

        var parent: ThreadArrangementCollection
        private weak var view: UICollectionView?
        private var dataSource: UICollectionViewDiffableDataSource<Int, String>?
        private var rows: [Row] = []
        private var expanded = Set<ThreadArrangementSection>()
        private var draggedID: String?
        private var pendingRows: [Row]?

        init(parent: ThreadArrangementCollection) { self.parent = parent }

        func configure(_ view: UICollectionView) {
            self.view = view
            let registration = UICollectionView.CellRegistration<UICollectionViewListCell, String> {
                [weak self] cell, _, id in
                self?.configure(cell, id: id)
            }
            dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: view) {
                collection, indexPath, id in
                collection.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
            }
            update()
        }

        func update(completion: (() -> Void)? = nil) {
            guard draggedID == nil || pendingRows != nil else { return }
            if let pendingRows {
                rows = pendingRows
            } else {
                let index = DailyUXSidebarIndex(snapshot: parent.model.snapshot, query: "", now: parent.now)
                rows = ThreadArrangementSection.allCases.flatMap { section -> [Row] in
                    let threads: [FeatureThread]
                    switch section {
                    case .pinned: threads = index.pinned
                    case .active: threads = index.active
                    case .snoozed: threads = index.snoozed
                    case .settled: threads = index.settled
                    }
                    if section == .snoozed, threads.isEmpty { return [] }
                    let visible = section.orderSection != nil || expanded.contains(section)
                    return [Row(section: section)] + (visible ? threads.map { Row(section: section, thread: $0) } : [])
                }
            }
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(rows.map(\.id))
            if let existing = dataSource?.snapshot().itemIdentifiers {
                let previousIDs = Set(existing)
                snapshot.reconfigureItems(rows.map(\.id).filter { previousIDs.contains($0) })
            }
            dataSource?.apply(snapshot, animatingDifferences: !UIAccessibility.isReduceMotionEnabled, completion: completion)
        }

        private func configure(_ cell: UICollectionViewListCell, id: String) {
            guard let row = rows.first(where: { $0.id == id }) else { return }
            cell.backgroundConfiguration = .clear()
            cell.accessories = []
            if let thread = row.thread {
                let enabled = !parent.model.isArrangingThreads && canLift(thread)
                cell.contentConfiguration = UIHostingConfiguration {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(thread.title).font(.system(size: 15)).foregroundStyle(.white).lineLimit(1)
                            if let name = thread.environmentName {
                                Text(name).font(.system(size: 11)).foregroundStyle(.gray).lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(enabled ? Color.white : Color.gray)
                            .frame(width: 48, height: 48)
                    }
                    .frame(height: 56)
                    .padding(.horizontal, 16)
                    .background(.black)
                }.margins(.all, 0)
                cell.isAccessibilityElement = true
                cell.accessibilityLabel = thread.title
                cell.accessibilityValue = row.section.title
                cell.accessibilityHint = "Use actions to change order or section."
                cell.accessibilityTraits = .button
                cell.accessibilityCustomActions = accessibilityActions(thread, section: row.section)
            } else {
                let expandable = row.section.orderSection == nil
                let isExpanded = expanded.contains(row.section)
                cell.contentConfiguration = UIHostingConfiguration {
                    HStack {
                        Text(row.section.title).font(.system(size: 14, weight: .semibold))
                        Spacer()
                        if expandable {
                            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        }
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .frame(height: 48)
                    .background(.black)
                }.margins(.all, 0)
                cell.isAccessibilityElement = true
                cell.accessibilityLabel = row.section.title
                cell.accessibilityValue = expandable ? (expanded.contains(row.section) ? "Expanded" : "Collapsed") : nil
                cell.accessibilityHint = nil
                cell.accessibilityTraits = expandable ? [.header, .button] : .header
                cell.accessibilityCustomActions = []
            }
        }

        private func canLift(_ thread: FeatureThread) -> Bool {
            guard !thread.isArchived,
                  parent.model.snapshot.environments.contains(where: {
                    $0.id == thread.environmentID && $0.isEnabled && $0.connectionState == .connected
                  }) else { return false }
            return ThreadArrangementPlanner.canEnter(thread, section: .pinned, now: .now)
                || ThreadArrangementPlanner.canEnter(thread, section: .active, now: .now)
                || (thread.supportsSettlement == true && !thread.isEffectivelySettled() && thread.canSettleNow())
        }

        func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
            guard rows.indices.contains(indexPath.item), rows[indexPath.item].thread == nil,
                  !parent.model.isArrangingThreads else { return }
            let section = rows[indexPath.item].section
            guard section.orderSection == nil else { return }
            if expanded.contains(section) { expanded.remove(section) } else { expanded.insert(section) }
            update()
        }

        func collectionView(
            _ collectionView: UICollectionView,
            itemsForBeginning session: UIDragSession,
            at indexPath: IndexPath
        ) -> [UIDragItem] {
            guard !parent.model.isArrangingThreads, pendingRows == nil, rows.indices.contains(indexPath.item),
                  let thread = rows[indexPath.item].thread, canLift(thread),
                  let cell = collectionView.cellForItem(at: indexPath),
                  session.location(in: cell).x >= cell.bounds.maxX - 64 else { return [] }
            draggedID = thread.id
            let item = UIDragItem(itemProvider: NSItemProvider(object: thread.id as NSString))
            item.localObject = thread.id
            return [item]
        }

        func collectionView(
            _ collectionView: UICollectionView,
            dragSessionIsRestrictedToDraggingApplication session: UIDragSession
        ) -> Bool { true }

        func collectionView(
            _ collectionView: UICollectionView,
            dragSessionAllowsMoveOperation session: UIDragSession
        ) -> Bool { true }

        func collectionView(_ collectionView: UICollectionView, dragSessionDidEnd session: UIDragSession) {
            draggedID = nil
            parent.onAction(nil)
            update()
        }

        private func destination(at indexPath: IndexPath?) -> ThreadArrangementDestination? {
            guard let indexPath, indexPath.section == 0 else { return nil }
            if indexPath.item == rows.count, let last = rows.last {
                return ThreadArrangementDestination(section: last.section, targetID: last.thread?.id, after: true)
            }
            guard rows.indices.contains(indexPath.item) else { return nil }
            let row = rows[indexPath.item]
            return ThreadArrangementDestination(section: row.section, targetID: row.thread?.id)
        }

        func collectionView(
            _ collectionView: UICollectionView,
            dropSessionDidUpdate session: UIDropSession,
            withDestinationIndexPath indexPath: IndexPath?
        ) -> UICollectionViewDropProposal {
            guard session.localDragSession != nil, let id = draggedID,
                  let destination = destination(at: indexPath),
                  parent.model.arrangementPlan(id: id, destination: destination) != nil else {
                parent.onAction(nil)
                return UICollectionViewDropProposal(operation: .forbidden)
            }
            if let source = rows.first(where: { $0.thread?.id == id }) {
                parent.onAction(action(source: source.section, destination: destination.section))
            }
            return UICollectionViewDropProposal(
                operation: .move,
                intent: destination.targetID == nil ? .insertIntoDestinationIndexPath : .insertAtDestinationIndexPath
            )
        }

        func collectionView(_ collectionView: UICollectionView, performDropWith coordinator: UICollectionViewDropCoordinator) {
            guard let id = draggedID, let item = coordinator.items.first,
                  let destination = destination(at: coordinator.destinationIndexPath),
                  parent.model.arrangementPlan(id: id, destination: destination) != nil,
                  let moved = rows.first(where: { $0.thread?.id == id })?.thread else { return }
            var next = rows.filter { $0.thread?.id != id }
            let target = destination.targetID.flatMap { id in next.firstIndex { $0.thread?.id == id } }
                ?? next.firstIndex { $0.thread == nil && $0.section == destination.section }
            guard let target else { return }
            let insertAt = target + (destination.targetID == nil || destination.after ? 1 : 0)
            if destination.section.orderSection != nil || expanded.contains(destination.section) {
                next.insert(Row(section: destination.section, thread: moved), at: insertAt)
            }
            pendingRows = next
            let dropPath = IndexPath(item: min(insertAt, next.count - 1), section: 0)
            update {
                coordinator.drop(item.dragItem, toItemAt: dropPath)
            }
            commit(id, destination: destination)
        }

        private func commit(_ id: String, destination: ThreadArrangementDestination) {
            Task { [weak self] in
                guard let self else { return }
                _ = await parent.model.arrangeThread(id, destination: destination)
                pendingRows = nil
                draggedID = nil
                parent.onAction(nil)
                update()
            }
        }

        private func action(source: ThreadArrangementSection, destination: ThreadArrangementSection) -> String {
            if destination == .settled { return "Settle" }
            if source == destination { return "Reorder" }
            if destination == .pinned { return "Pin" }
            if source == .pinned { return "Unpin" }
            return source == .settled ? "Unsettle" : "Unsnooze"
        }

        private func accessibilityActions(_ thread: FeatureThread, section: ThreadArrangementSection) -> [UIAccessibilityCustomAction] {
            var choices: [(String, ThreadArrangementDestination)] = []
            if let orderSection = section.orderSection {
                let ordered = DailyUXSidebarIndex.orderedSection(parent.model.snapshot.threads, section: orderSection, now: .now)
                if let index = ordered.firstIndex(where: { $0.id == thread.id }) {
                    if index > 0 {
                        choices.append(("Move up", .init(section: section, targetID: ordered[index - 1].id)))
                    }
                    if index + 1 < ordered.count {
                        choices.append(("Move down", .init(section: section, targetID: ordered[index + 1].id, after: true)))
                    }
                }
            }
            for destination in [ThreadArrangementSection.pinned, .active, .settled] where destination != section {
                choices.append((action(source: section, destination: destination), .init(section: destination)))
            }
            return choices.compactMap { name, destination in
                guard parent.model.arrangementPlan(id: thread.id, destination: destination) != nil else { return nil }
                return UIAccessibilityCustomAction(name: name) { [weak self] _ in
                    guard let self, self.parent.model.arrangementPlan(id: thread.id, destination: destination) != nil else { return false }
                    self.commit(thread.id, destination: destination)
                    return true
                }
            }
        }
    }
}
