import Foundation
import Testing

@testable import T3Kit

@Suite("Workflow model routing coding")
struct WorkflowModelRoutingCodingTests {
    @Test("task model selections decode independently")
    func decodesRoutes() throws {
        let routing = try WireCoding.decoder.decode(
            WorkflowModelRouting.self,
            from: Data(
                """
                {"explore":{"instanceId":"codex","model":"gpt-5.6-luna"},
                 "implement":{"instanceId":"claudeAgent","model":"claude-fable-5"},
                 "verify":null}
                """.utf8))

        #expect(routing.explore?.instanceId == "codex")
        #expect(routing.explore?.model == "gpt-5.6-luna")
        #expect(routing.implement?.instanceId == "claudeAgent")
        #expect(routing.verify == nil)
    }

    @Test("settings patch sends all three routes as one preference")
    func encodesPatch() throws {
        let patch = ServerSettingsPatch(
            workflowModelRouting: WorkflowModelRouting(
                explore: ModelSelection(instanceId: "codex", model: "gpt-5.6-luna"),
                implement: nil,
                verify: ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5")))
        let data = try WireCoding.encoder.encode(patch)
        let encoded = try WireCoding.decoder.decode(JSONValue.self, from: data)

        guard case .object(let fields) = encoded,
            case .object(let routing)? = fields["workflowModelRouting"]
        else {
            Issue.record("expected workflowModelRouting in the settings patch")
            return
        }
        guard case .null? = routing["implement"] else {
            Issue.record("expected a null implement route")
            return
        }
        guard case .object(let explore)? = routing["explore"] else {
            Issue.record("expected an explore selection")
            return
        }
        #expect(explore["instanceId"] == .string("codex"))
        #expect(explore["model"] == .string("gpt-5.6-luna"))
    }
}
