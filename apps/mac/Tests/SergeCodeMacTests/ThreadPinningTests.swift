import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Thread pinning")
@MainActor
struct ThreadPinningTests {
    @Test("pinned rows retain their relative order and precede unpinned rows")
    func pinnedRowsComeFirst() {
        let threads = [
            makeThread(id: "newest", at: 3),
            makeThread(id: "pinned-later", at: 2),
            makeThread(id: "pinned-earlier", at: 1),
        ]

        let ordered = AppModel.pinnedFirst(
            threads, pinnedIDs: ["pinned-later", "pinned-earlier"])

        #expect(ordered.map(\.id) == ["pinned-later", "pinned-earlier", "newest"])
    }

    @Test("manual order keeps saved rows stable and puts new rows first")
    func manualOrderMergesNewRows() {
        let threads = [
            makeThread(id: "newest", at: 3),
            makeThread(id: "saved-first", at: 2),
            makeThread(id: "saved-second", at: 1),
        ]

        let ordered = AppModel.manuallyOrdered(
            threads, order: ["saved-second", "saved-first"])

        #expect(ordered.map(\.id) == ["newest", "saved-second", "saved-first"])
    }

    @Test("manual moves stay within the pinned or unpinned group")
    func reorderDestinationBoundsRespectPinBoundary() {
        let threads = [
            makeThread(id: "pinned-first", at: 4),
            makeThread(id: "pinned-second", at: 3),
            makeThread(id: "unpinned-first", at: 2),
            makeThread(id: "unpinned-second", at: 1),
        ]
        let pinnedIDs: Set<String> = ["pinned-first", "pinned-second"]

        #expect(
            AppModel.reorderDestinationBounds(
                threads, fromOffsets: IndexSet(integer: 0), pinnedIDs: pinnedIDs)?.contains(2)
                == true)
        #expect(
            AppModel.reorderDestinationBounds(
                threads, fromOffsets: IndexSet(integer: 1), pinnedIDs: pinnedIDs)?.contains(4)
                == false)
        #expect(
            AppModel.reorderDestinationBounds(
                threads, fromOffsets: IndexSet(integer: 2), pinnedIDs: pinnedIDs)?.contains(1)
                == false)
        #expect(
            AppModel.reorderDestinationBounds(
                threads, fromOffsets: IndexSet(integer: 2), pinnedIDs: pinnedIDs)?.contains(4)
                == true)
    }

    @Test("complete sidebar order persists but cannot cross the pin boundary")
    func completeSidebarOrderRespectsPinBoundary() {
        let suffix = UUID().uuidString
        let projectID = "project-\(suffix)"
        let pinned = makeThread(id: "pinned-\(suffix)", projectID: projectID, at: 3)
        let first = makeThread(id: "first-\(suffix)", projectID: projectID, at: 2)
        let second = makeThread(id: "second-\(suffix)", projectID: projectID, at: 1)
        let model = AppModel(
            backend: MockBackend(),
            deviceID: DeviceID(rawValue: "ordering-\(suffix)"))
        model.enqueue(.projectsChanged([Project(id: projectID, name: "Project", path: "/tmp")]))
        [pinned, first, second].forEach { model.enqueue(.threadUpserted($0)) }
        model.flushPendingEvents()

        model.togglePinned(pinned)
        defer { model.togglePinned(pinned) }

        model.applySidebarOrder([pinned, second, first], projectID: projectID)
        #expect(model.manualThreadOrder[projectID] == [pinned.id, second.id, first.id])

        model.applySidebarOrder([second, pinned, first], projectID: projectID)
        #expect(model.manualThreadOrder[projectID] == [pinned.id, second.id, first.id])
    }

    private func makeThread(
        id: String,
        projectID: String = "project",
        at timestamp: TimeInterval
    ) -> ChatThread {
        ChatThread(
            id: id,
            projectID: projectID,
            title: id,
            provider: .codex,
            status: .idle,
            updatedAt: Date(timeIntervalSince1970: timestamp))
    }
}
