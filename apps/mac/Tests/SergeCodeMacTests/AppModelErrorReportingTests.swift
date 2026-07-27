// AppModelErrorReportingTests.swift
// Every catch block in AppModel funnels through `report(_:)`. The regression it
// exists for: selecting a freshly created thread changes `selectedThreadID`,
// SwiftUI cancels the `.task(id:)` bodies driving the timeline/diff/checkpoint
// fetches, and the interrupted RPCs throw `CancellationError`. That used to
// land in `lastError`, so a brand-new thread opened with "CancellationError()"
// pinned over its composer regardless of provider.

import Foundation
import T3Kit
import Testing

@testable import SergeCodeMac

private struct SomethingBroke: Error {}

@Suite("AppModel error reporting")
@MainActor
struct AppModelErrorReportingTests {
    @Test("cancellation never reaches the error banner")
    func cancellationIsNotReported() {
        let model = AppModel(backend: MockBackend())

        model.report(CancellationError())
        #expect(model.lastError == nil)

        model.report(URLError(.cancelled))
        #expect(model.lastError == nil)
    }

    @Test("real failures still reach the error banner")
    func realFailuresAreReported() {
        let model = AppModel(backend: MockBackend())

        model.report(T3Error.connectionClosed(reason: "socket closed"))
        #expect(model.lastError != nil)

        model.lastError = nil
        model.report(SomethingBroke())
        #expect(model.lastError != nil)
    }

    @Test("cancellation does not clear an error already on screen")
    func cancellationLeavesAnExistingErrorAlone() {
        let model = AppModel(backend: MockBackend())
        model.report(SomethingBroke())
        let reported = model.lastError

        model.report(CancellationError())
        #expect(model.lastError == reported)
    }
}
