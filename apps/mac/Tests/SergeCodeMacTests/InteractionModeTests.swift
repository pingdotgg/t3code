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

        #expect(LiveBackend.wireInteractionMode(.advisor) == .advisor)
        #expect(LiveBackend.uiInteractionMode(.advisor) == .advisor)
    }

    @Test("advisor holds the thread at approvals-required whatever the runtime mode says")
    func advisorClampsEffectiveRuntimeMode() throws {
        for runtimeMode in ThreadRuntimeMode.allCases {
            let advisor = thread(runtimeMode: runtimeMode, interactionMode: .advisor)
            #expect(advisor.effectiveRuntimeMode == .approvalRequired)

            // Only advisor clamps: plan is a prompt-level mode, so the thread's
            // own runtime mode still applies.
            for interactionMode in [ThreadInteractionMode.normal, .plan] {
                let unclamped = thread(runtimeMode: runtimeMode, interactionMode: interactionMode)
                #expect(unclamped.effectiveRuntimeMode == runtimeMode)
            }
        }
    }

    @Test("advisor is the only non-mutating interaction mode")
    func advisorIsTheOnlyNonMutatingMode() throws {
        #expect(ThreadInteractionMode.advisor.isNonMutating)
        #expect(!ThreadInteractionMode.plan.isNonMutating)
        #expect(!ThreadInteractionMode.normal.isNonMutating)
    }

    @Test("advisor display name is Advisor/Planner")
    func advisorDisplayName() throws {
        #expect(ThreadInteractionMode.advisor.displayName == "Advisor/Planner")
    }

    @Test("MockBackend setExecutorModel round-trips instance and model ids")
    func mockBackendSetExecutorModelRoundTrip() async throws {
        let backend = MockBackend()
        let threadID = "thread-1"
        try await backend.setInteractionMode(threadID: threadID, mode: .advisor)
        try await backend.setExecutorModel(
            threadID: threadID, instanceID: "provider-codex", modelID: "gpt-5-codex")

        let withExecutor = try #require(await backend.threads().first { $0.id == threadID })
        #expect(withExecutor.executorModelInstanceID == "provider-codex")
        #expect(withExecutor.executorModelID == "gpt-5-codex")
        #expect(withExecutor.effectiveRuntimeMode == .approvalRequired)

        try await backend.setExecutorModel(threadID: threadID, instanceID: nil, modelID: nil)
        let cleared = try #require(await backend.threads().first { $0.id == threadID })
        #expect(cleared.executorModelInstanceID == nil)
        #expect(cleared.executorModelID == nil)
    }

    @Test("MockBackend setExecutorModel clears both fields on a partial selection")
    func mockBackendSetExecutorModelClearsPartialSelection() async throws {
        let backend = MockBackend()
        let threadID = "thread-1"
        try await backend.setExecutorModel(
            threadID: threadID, instanceID: "provider-codex", modelID: "gpt-5-codex")

        // LiveBackend only accepts a complete pair; partial args clear both.
        try await backend.setExecutorModel(
            threadID: threadID, instanceID: "provider-claude", modelID: nil)
        let partialModel = try #require(await backend.threads().first { $0.id == threadID })
        #expect(partialModel.executorModelInstanceID == nil)
        #expect(partialModel.executorModelID == nil)

        try await backend.setExecutorModel(
            threadID: threadID, instanceID: "provider-codex", modelID: "gpt-5-codex")
        try await backend.setExecutorModel(
            threadID: threadID, instanceID: nil, modelID: "orphaned-model")
        let partialInstance = try #require(await backend.threads().first { $0.id == threadID })
        #expect(partialInstance.executorModelInstanceID == nil)
        #expect(partialInstance.executorModelID == nil)
    }

    @Test("advisor helpText describes no-executor advise-only behavior")
    func advisorHelpTextDescribesNoExecutor() throws {
        #expect(ThreadInteractionMode.advisor.helpText.contains("otherwise it advises only"))
        #expect(ThreadInteractionMode.advisor.helpText.contains("cannot edit the workspace itself"))
    }

    private func thread(
        runtimeMode: ThreadRuntimeMode, interactionMode: ThreadInteractionMode
    ) -> ChatThread {
        ChatThread(
            id: "thread-1", projectID: "project-1", title: "Advisor", provider: .codex,
            status: .idle, updatedAt: Date(timeIntervalSince1970: 0),
            runtimeMode: runtimeMode, interactionMode: interactionMode)
    }
}
