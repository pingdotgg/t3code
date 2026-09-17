import Foundation
import Testing
@testable import T3Code

@Suite("Native runtime parity")
struct NativeRuntimeParityTests {
    @Test(arguments: ["runtime.warning", "runtime.error"])
    func runtimeNoticesKeepTheFullMessageAndMetadata(kind: String) throws {
        let createdAt = Date(timeIntervalSince1970: 100)
        let fullMessage = "The provider could not complete the request.\n"
            + String(repeating: "Connection details remain available here.\n", count: 60)
        let event = activity(
            kind: kind,
            tone: kind == "runtime.error" ? "error" : "info",
            summary: "Short summary",
            payload: [
                "message": .string(fullMessage),
                "detail": .string("Do not append this fallback detail."),
            ]
        )

        let notice = try #require(NativeActivityNotice.message(event, createdAt: createdAt))

        #expect(notice.text == fullMessage)
        #expect(notice.role == .system)
        #expect(notice.createdAt == createdAt)
        #expect(notice.toolName == kind)
    }

    @Test
    func compactionResultsUseAStandaloneSummary() throws {
        let createdAt = Date(timeIntervalSince1970: 110)
        let event = activity(
            kind: "context-compaction",
            summary: "Context compacted.",
            payload: [
                "message": .string("Provider response details"),
                "detail": .string("Internal compaction details"),
            ]
        )

        let notice = try #require(NativeActivityNotice.message(event, createdAt: createdAt))

        #expect(notice.text == "Context compacted.")
        #expect(notice.role == .system)
        #expect(notice.createdAt == createdAt)
        #expect(notice.toolName == "context-compaction")
    }

    @Test(arguments: ["context-compaction", "provider.turn.start.failed"])
    func compactionSettlesOnlyForTheLatestMatchingRequest(kind: String) {
        let earlierDate = Date(timeIntervalSince1970: 100)
        let requestedAt = earlierDate.addingTimeInterval(10)
        let earlier = message(id: "earlier", createdAt: earlierDate)
        let current = message(id: "current", createdAt: requestedAt)
        var state = NativeContextCompactionState()
        state.apply(earlier, createdAt: earlierDate)
        state.apply(current, createdAt: requestedAt)

        #expect(state.isActive(
            sessionStatus: "running", latestTurnState: "running", latestTurnRequestedAt: requestedAt
        ))

        state.apply(earlier, createdAt: earlierDate)
        state.apply(activity(kind: kind, payload: ["requestId": .string("earlier")]))
        #expect(state.isActive(
            sessionStatus: "running", latestTurnState: "running", latestTurnRequestedAt: requestedAt
        ))

        state.apply(activity(kind: kind, payload: ["requestId": .string("current")]))
        #expect(!state.isActive(
            sessionStatus: "running", latestTurnState: "running", latestTurnRequestedAt: requestedAt
        ))

        state.apply(current, createdAt: requestedAt)
        #expect(!state.isActive(
            sessionStatus: "running", latestTurnState: "running", latestTurnRequestedAt: requestedAt
        ))

        let nextDate = requestedAt.addingTimeInterval(10)
        state.apply(message(id: "next", createdAt: nextDate), createdAt: nextDate)
        #expect(state.isActive(
            sessionStatus: "running", latestTurnState: "running", latestTurnRequestedAt: nextDate
        ))
    }

    @Test
    func compactionStopsForANewerTurnOrAnEndedSession() {
        let requestedAt = Date(timeIntervalSince1970: 100)
        var state = NativeContextCompactionState()
        state.apply(message(id: "compact", createdAt: requestedAt), createdAt: requestedAt)

        #expect(state.isActive(
            sessionStatus: "starting",
            latestTurnState: "completed",
            latestTurnRequestedAt: requestedAt.addingTimeInterval(-10)
        ))
        #expect(!state.isActive(
            sessionStatus: "running", latestTurnState: "completed", latestTurnRequestedAt: requestedAt
        ))

        let nextTurnDate = requestedAt.addingTimeInterval(10)
        state.apply(
            message(id: "normal-turn", createdAt: nextTurnDate, text: "Explain this function."),
            createdAt: nextTurnDate
        )
        #expect(!state.isActive(
            sessionStatus: "running", latestTurnState: "running", latestTurnRequestedAt: nextTurnDate
        ))

        let endedStatuses: [String?] = ["ready", "stopped", "error", nil]
        for status in endedStatuses {
            #expect(!state.isActive(
                sessionStatus: status, latestTurnState: "running", latestTurnRequestedAt: requestedAt
            ))
        }
    }

    @Test
    func unsupportedRestartPreferenceLeavesOtherSharedValuesIntact() throws {
        let sharedValues: [String: JSONValue] = [
            "defaultThreadEnvMode": .string("worktree"),
            "sidebarAutoSettleAfterDays": .null,
            "sourceControlWritingStyle": .object([
                "mode": .string("conventional_commits"),
                "customInstructions": .string("Keep messages short."),
            ]),
        ]
        var valuesWithRestart = sharedValues
        valuesWithRestart["continueThreadsAfterServerUpdate"] = .bool(true)
        let change = ServerSettingsChange.sharedPreferences(.object(valuesWithRestart))

        let filtered = try #require(NativeSharedPreferenceChange.filter(
            change, supportsRestartContinuation: false
        ))

        #expect(filtered.jsonValue == .object(sharedValues))
        #expect(NativeSharedPreferenceChange.filter(
            change, supportsRestartContinuation: true
        ) == change)
        #expect(NativeSharedPreferenceChange.filter(
            .defaultThreadEnvMode(.worktree), supportsRestartContinuation: false
        ) == .defaultThreadEnvMode(.worktree))
    }

    @Test
    func unsupportedRestartOnlyChangesAreNotSent() {
        let changes: [ServerSettingsChange] = [
            .continueThreadsAfterServerUpdate(true),
            .sharedPreferences(.object(["continueThreadsAfterServerUpdate": .bool(false)])),
        ]

        for change in changes {
            #expect(NativeSharedPreferenceChange.filter(
                change, supportsRestartContinuation: false
            ) == nil)
            #expect(NativeSharedPreferenceChange.filter(
                change, supportsRestartContinuation: true
            ) == change)
        }
    }

    private func message(
        id: String,
        createdAt: Date,
        text: String = "/compact"
    ) -> OrchestrationMessage {
        OrchestrationMessage(
            id: id,
            role: "user",
            text: text,
            attachments: nil,
            turnId: nil,
            streaming: false,
            createdAt: createdAt.ISO8601Format(),
            updatedAt: createdAt.ISO8601Format()
        )
    }

    private func activity(
        kind: String,
        tone: String = "info",
        summary: String = "Context compacted.",
        payload: [String: JSONValue] = [:]
    ) -> OrchestrationActivity {
        OrchestrationActivity(
            id: "notice-\(kind)",
            tone: tone,
            kind: kind,
            summary: summary,
            payload: .object(payload),
            turnId: nil,
            sequence: nil,
            createdAt: "2026-09-05T12:00:00Z"
        )
    }
}
