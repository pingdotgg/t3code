import Testing

@testable import SergeCodeMac

@Suite("Agent notification policy")
struct AgentNotificationPolicyTests {
    private typealias Snapshot = AgentNotificationPolicy.ThreadSnapshot
    private typealias Context = AgentNotificationPolicy.DeliveryContext

    @Test("first observation of a thread never notifies")
    func firstObservationSilent() {
        let next = Snapshot(status: .idle, isStalled: false)
        #expect(AgentNotificationPolicy.statusTransitionKind(previous: nil, next: next) == nil)

        let waiting = Snapshot(status: .waitingApproval, isStalled: false)
        #expect(AgentNotificationPolicy.statusTransitionKind(previous: nil, next: waiting) == nil)
    }

    @Test("running to idle notifies finished")
    func finishedAfterWork() {
        let previous = Snapshot(status: .running, isStalled: false)
        let next = Snapshot(status: .idle, isStalled: false)
        #expect(
            AgentNotificationPolicy.statusTransitionKind(previous: previous, next: next)
                == .finished)
    }

    @Test("background work to settled notifies finished")
    func finishedFromBackgroundWork() {
        let previous = Snapshot(status: .backgroundWork, isStalled: false)
        let next = Snapshot(status: .settled, isStalled: false)
        #expect(
            AgentNotificationPolicy.statusTransitionKind(previous: previous, next: next)
                == .finished)
    }

    @Test("idle to idle does not notify finished")
    func idleStaySilent() {
        let previous = Snapshot(status: .idle, isStalled: false)
        let next = Snapshot(status: .idle, isStalled: false)
        #expect(AgentNotificationPolicy.statusTransitionKind(previous: previous, next: next) == nil)
    }

    @Test("running to error notifies failed")
    func failed() {
        let previous = Snapshot(status: .running, isStalled: false)
        let next = Snapshot(status: .error, isStalled: false)
        #expect(
            AgentNotificationPolicy.statusTransitionKind(previous: previous, next: next) == .failed)
    }

    @Test("stalled flip notifies even while status stays running")
    func stalled() {
        let previous = Snapshot(status: .running, isStalled: false)
        let next = Snapshot(status: .running, isStalled: true)
        #expect(
            AgentNotificationPolicy.statusTransitionKind(previous: previous, next: next) == .stalled)
    }

    @Test("stall recovery is silent")
    func stallRecoverySilent() {
        let previous = Snapshot(status: .running, isStalled: true)
        let next = Snapshot(status: .running, isStalled: false)
        #expect(AgentNotificationPolicy.statusTransitionKind(previous: previous, next: next) == nil)
    }

    @Test("entering waitingApproval notifies needsApproval")
    func needsApproval() {
        let previous = Snapshot(status: .running, isStalled: false)
        let next = Snapshot(status: .waitingApproval, isStalled: false)
        #expect(
            AgentNotificationPolicy.statusTransitionKind(previous: previous, next: next)
                == .needsApproval)
    }

    @Test("delivery suppressed when app active and thread selected")
    func suppressWhenViewing() {
        #expect(
            AgentNotificationPolicy.shouldDeliver(
                kind: .finished,
                masterEnabled: true,
                enabledKinds: Set(AgentNotificationKind.allCases),
                context: Context(isAppActive: true, isThreadSelected: true)) == false)
    }

    @Test("delivery allowed when app active but another thread selected")
    func allowWhenOtherThread() {
        #expect(
            AgentNotificationPolicy.shouldDeliver(
                kind: .finished,
                masterEnabled: true,
                enabledKinds: Set(AgentNotificationKind.allCases),
                context: Context(isAppActive: true, isThreadSelected: false)))
    }

    @Test("delivery allowed when app inactive even if thread selected")
    func allowWhenInactive() {
        #expect(
            AgentNotificationPolicy.shouldDeliver(
                kind: .needsInput,
                masterEnabled: true,
                enabledKinds: Set(AgentNotificationKind.allCases),
                context: Context(isAppActive: false, isThreadSelected: true)))
    }

    @Test("master off blocks all kinds")
    func masterOff() {
        #expect(
            AgentNotificationPolicy.shouldDeliver(
                kind: .failed,
                masterEnabled: false,
                enabledKinds: Set(AgentNotificationKind.allCases),
                context: Context(isAppActive: false, isThreadSelected: false)) == false)
    }

    @Test("disabled kind is skipped")
    func kindDisabled() {
        #expect(
            AgentNotificationPolicy.shouldDeliver(
                kind: .stalled,
                masterEnabled: true,
                enabledKinds: [.finished, .failed],
                context: Context(isAppActive: false, isThreadSelected: false)) == false)
    }

    @Test("copy includes thread title and project")
    func copy() {
        #expect(
            AgentNotificationPolicy.notificationTitle(kind: .finished, threadTitle: "Fix CI")
                == "Fix CI finished")
        #expect(
            AgentNotificationPolicy.notificationBody(kind: .stalled, projectName: "SergeCode")
                == "No recent provider activity · SergeCode.")
        #expect(
            AgentNotificationPolicy.notificationBody(
                kind: .needsInput, projectName: nil, detail: "Which package manager?")
                == "Which package manager?")
    }
}
