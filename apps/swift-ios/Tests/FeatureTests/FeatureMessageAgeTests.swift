import Foundation
import Testing
@testable import T3Code

struct FeatureMessageAgeTests {
    @Test func elapsedUnitsAndFutureClockSkew() {
        let date = Date(timeIntervalSince1970: 1_000)
        let age = FeatureMessageAge(sentAt: date)
        for (seconds, expected) in [(-8, "0s"), (8, "8s"), (59, "59s"), (60, "1m"),
                                    (3_599, "59m"), (3_600, "1h"), (86_400, "1d")] {
            #expect(age.text(at: date.addingTimeInterval(Double(seconds))) == expected)
        }
    }

    @Test func usesConversationMessageNotToolStatusOrQueuedDraft() {
        let first = FeatureMessage(id: "user", role: .user, text: "Check this", createdAt: Date(timeIntervalSince1970: 10))
        let reply = FeatureMessage(id: "reply", role: .assistant, text: "Checking", createdAt: Date(timeIntervalSince1970: 20))
        let tool = FeatureMessage(id: "tool", role: .tool, text: "Read file", createdAt: Date(timeIntervalSince1970: 30))
        let status = FeatureMessage(id: "status", role: .system, text: "Connected", createdAt: Date(timeIntervalSince1970: 40))
        let queued = FeatureMessage(id: "draft", role: .user, text: "Next", createdAt: Date(timeIntervalSince1970: 50), state: .queued)
        #expect(FeatureMessageAge.lastMessageDate(in: []) == nil)
        #expect(FeatureMessageAge.lastMessageDate(in: [tool, status, queued]) == nil)
        #expect(FeatureMessageAge.lastMessageDate(in: [first, tool]) == first.createdAt)
        #expect(FeatureMessageAge.lastMessageDate(in: [first, reply, tool, status, queued]) == reply.createdAt)
    }
}
