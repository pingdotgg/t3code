import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Tool handoff flight")
struct ToolHandoffTests {
    private let base = Date(timeIntervalSinceReferenceDate: 5_000)

    private func tool(
        id: String,
        status: ToolEventStatus = .running,
        offset: TimeInterval = 0
    ) -> TimelineItem {
        .toolEvent(
            id: id, name: "run_command", detail: "", kind: .command, status: status,
            at: base.addingTimeInterval(offset), output: nil, outputIsError: false)
    }

    private func userMessage(offset: TimeInterval = 0) -> TimelineItem {
        .userMessage(
            id: "u\(offset)", text: "go", attachments: [],
            at: base.addingTimeInterval(offset))
    }

    // MARK: - Scan input

    @Test("the scan collects every running tool id for the current turn")
    func scanCollectsRunningIDs() {
        let scan = TimelineActivityScan.scan(items: [
            userMessage(),
            tool(id: "done", status: .succeeded, offset: 1),
            tool(id: "a", offset: 2),
            tool(id: "b", offset: 3),
        ])
        #expect(scan.turn.runningToolIDs == ["a", "b"])
    }

    @Test("running ids from an old turn do not leak into the new one")
    func scanResetsRunningIDsPerTurn() {
        let scan = TimelineActivityScan.scan(items: [
            userMessage(offset: 0),
            tool(id: "stale", offset: 1),
            userMessage(offset: 10),
            tool(id: "live", offset: 11),
        ])
        #expect(scan.turn.runningToolIDs == ["live"])
    }

    // MARK: - Promotion detection

    @Test("a tool leaving the running set is the promoted one")
    func promotionIsADisappearance() {
        #expect(
            ToolHandoffPolicy.promotedToolID(
                previousRunningIDs: ["a"], currentRunningIDs: []) == "a")
        // The next tool starting in the same delta must not mask it.
        #expect(
            ToolHandoffPolicy.promotedToolID(
                previousRunningIDs: ["a"], currentRunningIDs: ["b"]) == "a")
    }

    @Test("nothing is promoted on a first scan, a start, or an unchanged set")
    func nonPromotionsReportNothing() {
        // First render of a hydrated mid-turn thread: flights would replay
        // work the user already watched land.
        #expect(
            ToolHandoffPolicy.promotedToolID(
                previousRunningIDs: [], currentRunningIDs: ["a"]) == nil)
        #expect(
            ToolHandoffPolicy.promotedToolID(
                previousRunningIDs: ["a"], currentRunningIDs: ["a"]) == nil)
        #expect(
            ToolHandoffPolicy.promotedToolID(
                previousRunningIDs: ["a"], currentRunningIDs: ["a", "b"]) == nil)
    }

    @Test("when several tools finish at once the newest flies")
    func newestOfSeveralWins() {
        #expect(
            ToolHandoffPolicy.promotedToolID(
                previousRunningIDs: ["a", "b"], currentRunningIDs: []) == "b")
        #expect(
            ToolHandoffPolicy.promotedToolID(
                previousRunningIDs: ["a", "b"], currentRunningIDs: ["b"]) == "a")
    }

    // MARK: - Flight window

    @Test("a flight owns its row for the window and not a moment longer")
    func flightWindowBounds() {
        #expect(ToolHandoffPolicy.isFlightActive(startedAt: base, now: base))
        #expect(
            ToolHandoffPolicy.isFlightActive(
                startedAt: base,
                now: base.addingTimeInterval(ToolHandoffPolicy.flightWindow - 0.01)))
        // Not the exact boundary: `Date` arithmetic rounds through Double,
        // and the window's edge is not behavior anyone depends on.
        #expect(
            !ToolHandoffPolicy.isFlightActive(
                startedAt: base,
                now: base.addingTimeInterval(ToolHandoffPolicy.flightWindow + 0.05)))
    }

    // MARK: - Tracker

    @Test("the tracker keeps the promoted id sticky across mid-flight renders")
    @MainActor
    func trackerStickiness() {
        let tracker = ToolHandoffTracker()

        // Hydration render: a tool is already running, nothing flies.
        #expect(tracker.activeFlightID(runningToolIDs: ["a"], now: base) == nil)

        // The tool completes: its row flies…
        let promotedAt = base.addingTimeInterval(1)
        #expect(tracker.activeFlightID(runningToolIDs: [], now: promotedAt) == "a")
        // …and streaming re-renders inside the window keep it flying.
        #expect(
            tracker.activeFlightID(
                runningToolIDs: [], now: promotedAt.addingTimeInterval(0.4)) == "a")
        // Past the window the row goes back to being an ordinary sibling.
        #expect(
            tracker.activeFlightID(
                runningToolIDs: [],
                now: promotedAt.addingTimeInterval(ToolHandoffPolicy.flightWindow + 0.05)) == nil)
    }

    @Test("a second promotion hands the flight to the newer row")
    @MainActor
    func trackerReplacesFlights() {
        let tracker = ToolHandoffTracker()
        #expect(tracker.activeFlightID(runningToolIDs: ["a"], now: base) == nil)
        #expect(
            tracker.activeFlightID(
                runningToolIDs: ["b"], now: base.addingTimeInterval(1)) == "a")
        #expect(
            tracker.activeFlightID(
                runningToolIDs: [], now: base.addingTimeInterval(1.2)) == "b")
    }

    @Test("the launch pose is invisible and, with movement, offset into the dock")
    func launchPose() {
        let moving = ToolHandoffFrame.launch(movement: true)
        #expect(moving.opacity == 0)
        #expect(moving.y == ToolHandoffPolicy.travel)
        #expect(moving.scale < 1)
        #expect(moving.wash == 1)

        // Reduce Motion: the fades stay (the row still never pops), the
        // travel and grow-in go.
        let still = ToolHandoffFrame.launch(movement: false)
        #expect(still.opacity == 0)
        #expect(still.y == 0)
        #expect(still.scale == 1)
    }
}
