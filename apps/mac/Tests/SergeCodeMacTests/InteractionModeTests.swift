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

    private func thread(
        runtimeMode: ThreadRuntimeMode, interactionMode: ThreadInteractionMode
    ) -> ChatThread {
        ChatThread(
            id: "thread-1", projectID: "project-1", title: "Plan", provider: .codex,
            status: .idle, updatedAt: Date(timeIntervalSince1970: 0),
            runtimeMode: runtimeMode, interactionMode: interactionMode)
    }
}
