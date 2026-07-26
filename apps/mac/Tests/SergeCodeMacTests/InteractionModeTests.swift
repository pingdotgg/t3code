import Foundation
import T3Kit
import Testing

@testable import SergeCodeMac

@Suite("InteractionMode")
struct InteractionModeTests {
    @Test("round-trips every interaction mode between the wire and the UI enum")
    func roundTripsInteractionModes() throws {
        for mode in ThreadInteractionMode.allCases {
            let wire = LiveBackend.wireInteractionMode(mode)
            #expect(LiveBackend.uiInteractionMode(wire) == mode)
        }
    }

    @Test("interaction mode does not clamp the thread's stored runtime mode")
    func interactionModeDoesNotClampRuntimeMode() throws {
        for runtimeMode in ThreadRuntimeMode.allCases {
            for interactionMode in ThreadInteractionMode.allCases {
                let thread = thread(runtimeMode: runtimeMode, interactionMode: interactionMode)
                #expect(thread.runtimeMode == runtimeMode)
            }
        }
    }

    @Test("plan display name is Plan")
    func planDisplayName() throws {
        #expect(ThreadInteractionMode.plan.displayName == "Plan")
        #expect(ThreadInteractionMode.normal.displayName == "Default")
    }

    @Test("advisor display name is Advisor/Planner")
    func advisorDisplayName() throws {
        #expect(ThreadInteractionMode.advisor.displayName == "Advisor/Planner")
    }

    @Test("advisor helpText describes no-executor advise-only behavior")
    func advisorHelpTextDescribesNoExecutor() throws {
        #expect(ThreadInteractionMode.advisor.helpText.contains("otherwise it advises only"))
    }

    @Test("MockBackend setExecutorModel round-trips ids and the sub-agent cap")
    func mockBackendSetExecutorModelRoundTrip() async throws {
        let backend = MockBackend()
        let threadID = "thread-1"
        try await backend.setInteractionMode(threadID: threadID, mode: .advisor)
        try await backend.setExecutorModel(
            threadID: threadID, instanceID: "provider-codex", modelID: "gpt-5-codex",
            maxSubAgents: 5)

        let withExecutor = try #require(await backend.threads().first { $0.id == threadID })
        #expect(withExecutor.executorModelInstanceID == "provider-codex")
        #expect(withExecutor.executorModelID == "gpt-5-codex")
        #expect(withExecutor.executorMaxSubAgents == 5)
        // Runtime mode is independent of interaction mode / executor selection.
        #expect(withExecutor.runtimeMode == .fullAccess)

        // A nil cap leaves the stored value untouched.
        try await backend.setExecutorModel(
            threadID: threadID, instanceID: "provider-codex", modelID: "gpt-5-codex",
            maxSubAgents: nil)
        let unchangedCap = try #require(await backend.threads().first { $0.id == threadID })
        #expect(unchangedCap.executorMaxSubAgents == 5)

        try await backend.setExecutorModel(
            threadID: threadID, instanceID: nil, modelID: nil, maxSubAgents: nil)
        let cleared = try #require(await backend.threads().first { $0.id == threadID })
        #expect(cleared.executorModelInstanceID == nil)
        #expect(cleared.executorModelID == nil)
    }

    @Test("MockBackend setExecutorModel clears both fields on a partial selection")
    func mockBackendSetExecutorModelClearsPartialSelection() async throws {
        let backend = MockBackend()
        let threadID = "thread-1"
        try await backend.setExecutorModel(
            threadID: threadID, instanceID: "provider-codex", modelID: "gpt-5-codex",
            maxSubAgents: nil)

        // LiveBackend only accepts a complete pair; partial args clear both.
        try await backend.setExecutorModel(
            threadID: threadID, instanceID: "provider-claude", modelID: nil, maxSubAgents: nil)
        let partialModel = try #require(await backend.threads().first { $0.id == threadID })
        #expect(partialModel.executorModelInstanceID == nil)
        #expect(partialModel.executorModelID == nil)
    }

    private func thread(
        runtimeMode: ThreadRuntimeMode, interactionMode: ThreadInteractionMode
    ) -> ChatThread {
        ChatThread(
            id: "thread-1", projectID: "project-1", title: "Plan", provider: .codex,
            status: .idle, updatedAt: Date(timeIntervalSince1970: 0),
            runtimeMode: runtimeMode, interactionMode: interactionMode)
    }
}
