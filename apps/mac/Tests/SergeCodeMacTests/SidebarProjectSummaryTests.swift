import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Sidebar project summary")
@MainActor
struct SidebarProjectSummaryTests {
    @Test("meter bands fill the track exactly")
    func meterBandsFillTrack() {
        let summary = SidebarProjectSummary(attention: 1, running: 3, idle: 2, settled: 6)
        let segments = summary.segments

        #expect(segments.map(\.kind) == [.attention, .running, .idle, .settled])
        #expect(abs(segments.reduce(0) { $0 + $1.fraction } - 1) < 0.0001)
    }

    @Test("a lone attention thread keeps a visible band among many settled ones")
    func minimumShareKeepsRareBandVisible() {
        let summary = SidebarProjectSummary(attention: 1, running: 0, idle: 0, settled: 40)
        let attention = summary.segments.first { $0.kind == .attention }

        // Proportionally this band would be 1/41 of the track — a sub-pixel
        // sliver at the meter's 44pt width. The floor is what keeps the one
        // thread that wants a human on screen at all.
        #expect(attention?.fraction ?? 0 >= SidebarProjectSummary.minimumSegmentShare)
    }

    @Test("empty buckets contribute no bands")
    func emptyBucketsAreOmitted() {
        let summary = SidebarProjectSummary(attention: 0, running: 2, idle: 0, settled: 0)

        #expect(summary.segments.map(\.kind) == [.running])
        #expect(summary.segments[0].fraction == 1)
        #expect(SidebarProjectSummary.empty.segments.isEmpty)
    }

    @Test("subtitle leads with what wants a human, then with what is moving")
    func subtitlePrioritizesAttentionThenActivity() {
        #expect(
            SidebarProjectSummary(attention: 1, running: 2, idle: 4, settled: 9).subtitle
                == "1 needs attention · 2 running")
        #expect(
            SidebarProjectSummary(attention: 3, running: 0, idle: 0, settled: 0).subtitle
                == "3 need attention")
        #expect(
            SidebarProjectSummary(attention: 0, running: 0, idle: 2, settled: 5).subtitle
                == "2 open · 5 settled")
        #expect(
            SidebarProjectSummary(attention: 0, running: 0, idle: 0, settled: 4).subtitle
                == "4 settled")
        #expect(SidebarProjectSummary.empty.subtitle == "No sessions")
    }

    @Test("a group is bucketed into attention, running, idle and settled")
    func groupIsBucketed() {
        let model = makeModel(
            projects: [Project(id: "p", name: "SergeCode", path: "/p")],
            threads: [
                makeThread(id: "waiting-approval", status: .waitingApproval),
                makeThread(id: "running", status: .running),
                makeThread(id: "reviewing", status: .reviewing),
                makeThread(id: "idle", status: .idle),
                makeThread(id: "settled", status: .settled, settledOverride: "settled"),
            ])
        let groups = SidebarProjection.projectGroups(
            in: MultiDeviceModel(local: model, remoteSessions: []), scope: .all)

        let summary = SidebarProjectSummary(group: groups[0])

        #expect(summary.attention == 1)
        #expect(summary.running == 2)
        #expect(summary.idle == 1)
        #expect(summary.settled == 1)
        #expect(summary.open == 4)
        #expect(summary.total == 5)
        #expect(summary.isBusy)
        #expect(summary.needsAttention)
    }

    /// The header renders from the summary whether or not the section is
    /// expanded, and only expanded sections are ranked — so the counts have to
    /// agree with the ranked split, not merely be close to it.
    @Test("summary agrees with the ranked split for an expanded section")
    func summaryMatchesRankedSplit() {
        let model = makeModel(
            projects: [Project(id: "p", name: "SergeCode", path: "/p")],
            threads: [
                makeThread(id: "error", status: .error),
                makeThread(id: "running", status: .running),
                makeThread(id: "idle", status: .idle),
                makeThread(id: "settled", status: .settled, settledOverride: "settled"),
            ])
        let group = SidebarProjection.projectGroups(
            in: MultiDeviceModel(local: model, remoteSessions: []), scope: .all)[0]

        let summary = SidebarProjectSummary(group: group)
        let split = SidebarProjection.groupThreads(group)

        #expect(summary.open == split.active.count)
        #expect(summary.settled == split.settled.count)
    }

    @Test("a project with only settled sessions is neither busy nor attention-worthy")
    func settledOnlyProjectIsQuiet() {
        let summary = SidebarProjectSummary(attention: 0, running: 0, idle: 0, settled: 3)

        #expect(!summary.isBusy)
        #expect(!summary.needsAttention)
        #expect(!summary.isEmpty)
        #expect(summary.accessibilitySummary == "3 settled")
    }

    private func makeModel(projects: [Project], threads: [ChatThread]) -> AppModel {
        let model = AppModel(backend: MockBackend(), deviceID: .local, capabilities: .local)
        model.enqueue(.projectsChanged(projects))
        threads.forEach { model.enqueue(.threadUpserted($0)) }
        model.flushPendingEvents()
        return model
    }

    /// `settledOverride` rather than `status: .settled`: the disclosure is fed
    /// by `ThreadInboxSemantics.effectiveSettled`, which is the server's
    /// adjudication plus an auto-settle clock — a bare status is not enough to
    /// put a thread behind it.
    private func makeThread(
        id: String,
        status: ThreadStatus,
        settledOverride: String? = nil
    ) -> ChatThread {
        ChatThread(
            id: id,
            projectID: "p",
            title: id,
            provider: .codex,
            status: status,
            updatedAt: Date(timeIntervalSince1970: 1),
            settledOverride: settledOverride)
    }
}
