import Foundation
import XCTest
@testable import T3Code

final class UsageContractTests: XCTestCase {
    func testUsageSummaryDecodesCurrentWireContract() throws {
        let data = Data(
            #"""
            {
              "contractVersion": 3,
              "readAt": "2026-08-09T12:00:00.000Z",
              "timeZone": "America/Los_Angeles",
              "sinceDay": "2026-08-03",
              "untilDay": "2026-08-09",
              "buckets": [{
                "day": "2026-08-09",
                "provider": "codex",
                "model": "gpt-5.6-sol",
                "totals": {
                  "uncachedInputTokens": 100,
                  "cachedInputTokens": 200,
                  "cacheCreationTokens": 30,
                  "outputTokens": 40,
                  "reasoningTokens": 10
                },
                "costUsd": 1.25,
                "cacheSavingsUsd": 2.5,
                "costSource": "modelPriced",
                "records": 2,
                "unpricedRecords": 0,
                "sessions": 1
              }],
              "sources": [{
                "fingerprint": {
                  "hostId": "mac-1",
                  "provider": "codex",
                  "resolvedHomePath": "/Users/theo/.codex",
                  "volumeId": "1:2"
                },
                "status": "ok",
                "scannedFiles": 3,
                "skippedFiles": 0,
                "malformedRecords": 0,
                "distinctSessions": 1,
                "message": null
              }],
              "pricing": {
                "status": "fresh",
                "source": "LiteLLM",
                "fetchedAt": "2026-08-09T11:00:00.000Z",
                "knownModels": 200
              },
              "scanDurationMs": 14
            }
            """#.utf8
        )

        let summary = try JSONDecoder.t3.decode(UsageSummary.self, from: data)

        XCTAssertEqual(summary.contractVersion, usageContractVersion)
        XCTAssertEqual(summary.buckets.first?.provider, .codex)
        XCTAssertEqual(summary.buckets.first?.totals.cachedInputTokens, 200)
        XCTAssertEqual(summary.sources.first?.fingerprint.volumeId, "1:2")
    }
}
