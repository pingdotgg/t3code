import Foundation
import Testing
@testable import T3Code

struct FeatureCustomSnoozeTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func dateMustStillBeInTheFutureWhenConfirmed() {
        let input = FeatureCustomSnoozeInput.date(now.addingTimeInterval(60))
        #expect(input.resolve(now: now) == now.addingTimeInterval(60))
        #expect(input.resolve(now: now.addingTimeInterval(60)) == nil)
        #expect(input.resolve(now: now.addingTimeInterval(120)) == nil)
        #expect(FeatureCustomSnoozeInput.date(Date(timeIntervalSince1970: .infinity)).resolve(now: now) == nil)
    }

    @Test func durationsUseConfirmationTimeAndSupportDecimalInput() {
        let confirmed = now.addingTimeInterval(300)
        #expect(FeatureCustomSnoozeInput.duration(amount: "1,5", unit: .hours).resolve(now: confirmed)
            == confirmed.addingTimeInterval(5_400))
        #expect(FeatureCustomSnoozeInput.duration(amount: " 2 ", unit: .minutes).resolve(now: confirmed)
            == confirmed.addingTimeInterval(120))
        #expect(FeatureCustomSnoozeInput.duration(amount: "0.5", unit: .days).resolve(now: confirmed)
            == confirmed.addingTimeInterval(43_200))
    }

    @Test(arguments: ["", " ", "0", "-1", "NaN", "inf", "1e999", "1e20", "abc", "1,2,3"])
    func invalidDurationsAreRejected(_ value: String) {
        #expect(FeatureCustomSnoozeInput.duration(amount: value, unit: .hours).resolve(now: now) == nil)
    }

    @Test func durationDayIsElapsedTimeAcrossDaylightSaving() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let before = try #require(ISO8601DateFormatter().date(from: "2026-03-07T20:00:00Z"))
        let after = try #require(FeatureCustomSnoozeInput.duration(amount: "1", unit: .days).resolve(now: before))
        #expect(after.timeIntervalSince(before) == 86_400)
        #expect(calendar.component(.hour, from: before) == 12)
        #expect(calendar.component(.hour, from: after) == 13)
    }

    @Test func selectedTargetKeepsTheOriginalEnvironmentScopedIdentity() {
        let original = FeatureThread(
            id: FeatureScopedID.thread(environmentID: "first", wireID: "same"),
            projectID: "project", title: "Selected"
        )
        let other = FeatureThread(
            id: FeatureScopedID.thread(environmentID: "second", wireID: "same"),
            projectID: "project", title: "Recycled row"
        )
        let selection = FeatureCustomSnoozeSelection(thread: original)
        #expect(selection.id == original.id)
        #expect(selection.id != FeatureCustomSnoozeSelection(thread: other).id)
        #expect(selection.title == "Selected")
    }
}
