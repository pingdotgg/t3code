import Foundation
import T3Kit
import Testing

@testable import SergeCodeMac

@Suite("Approval mapping")
struct ApprovalMappingTests {
    @Test("approval kind classifies from the payload's requestKind")
    func kindFromRequestKind() {
        #expect(kind(["requestKind": .string("command")]) == .command)
        #expect(kind(["requestKind": .string("file-read")]) == .fileRead)
        #expect(kind(["requestKind": .string("file-change")]) == .fileEdit)
    }

    @Test("approval kind falls back to the canonical requestType")
    func kindFromRequestType() {
        #expect(kind(["requestType": .string("exec_command_approval")]) == .command)
        #expect(kind(["requestType": .string("command_execution_approval")]) == .command)
        #expect(kind(["requestType": .string("file_read_approval")]) == .fileRead)
        #expect(kind(["requestType": .string("apply_patch_approval")]) == .fileEdit)
        #expect(kind(["requestType": .string("file_change_approval")]) == .fileEdit)
        #expect(kind(["requestType": .string("dynamic_tool_call")]) == .other)
    }

    @Test("an uninformative payload classifies as other")
    func kindFallback() {
        #expect(kind([:]) == .other)
        #expect(LiveBackend.approvalKind(payload: .string("whatever")) == .other)
    }

    @Test("UI decisions map to wire decisions, session grant included")
    func decisionMapping() {
        #expect(LiveBackend.providerDecision(.approve) == .accept)
        #expect(LiveBackend.providerDecision(.approveForSession) == .acceptForSession)
        #expect(LiveBackend.providerDecision(.deny) == .decline)
    }

    private func kind(_ payload: [String: JSONValue]) -> ApprovalKind {
        LiveBackend.approvalKind(payload: .object(payload))
    }
}
