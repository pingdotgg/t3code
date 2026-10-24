import Testing
@testable import T3Code

@Suite("V2 server notice attribution")
struct FeatureV2ServerNoticeAttributionTests {
    @Test @MainActor func restartContinuationIsAttributedToT3Code() throws {
        let source = try metadata(creationSource: "server")

        #expect(FeatureV2MessageAttribution.attribution(source) == .t3code)
        #expect(FeatureV2MessageAttribution.hasContent(source))
    }

    @Test @MainActor func otherAgentSourcesKeepAgentAttribution() throws {
        for creationSource in ["mcp", "provider", "mobile", "web"] {
            #expect(FeatureV2MessageAttribution.attribution(try metadata(creationSource: creationSource)) == .agent)
        }
    }

    @Test @MainActor func scheduledTaskAttributionTakesPriority() throws {
        var source = try metadata(creationSource: "server")
        source.scheduledTaskID = "task"

        #expect(FeatureV2MessageAttribution.attribution(source) == .automation)
    }

    @Test @MainActor func serverSourceDoesNotAttributeUserOrSystemMessages() throws {
        for createdBy in ["user", "system"] {
            var source = try metadata(creationSource: "server")
            source.createdBy = createdBy

            #expect(FeatureV2MessageAttribution.attribution(source) == nil)
            #expect(!FeatureV2MessageAttribution.hasContent(source))
        }
    }

    private func metadata(creationSource: String) throws -> OrchestrationV2TimelineMetadata {
        let item = V2Fixture.patch(V2Fixture.user("restart", ordinal: 1), [
            "createdBy": .string("agent"), "creationSource": .string(creationSource),
            "senderThreadId": .string("sender"),
        ])
        return try OrchestrationV2TimelineMetadata(V2Fixture.row(item).decode(OrchestrationV2ProjectedTurnItem.self))
    }
}
