// CancellationSignalTests.swift
// `isCancellation` decides which failures reach the user. The two halves that
// matter are symmetric: every shape cancellation actually arrives in must be
// recognised (or a cancelled `.task` paints an error banner on a healthy
// thread), and nothing else may be (or a dropped socket fails silently).

import Foundation
import Testing

@testable import T3Kit

@Suite("Error.isCancellation")
struct CancellationSignalTests {
    @Test("recognises the shapes cancellation arrives in")
    func recognisesCancellation() {
        // What RpcConnection.request/interrupt throws (§2.4).
        #expect(CancellationError().isCancellation)
        // What URLSession's async data(for:) throws for a cancelled task.
        #expect(URLError(.cancelled).isCancellation)
        // The same condition after a bridge through NSError.
        #expect(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled).isCancellation)
        // Cocoa's spelling, e.g. a dismissed save panel.
        #expect(NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError).isCancellation)
    }

    @Test("does not swallow real failures")
    func rejectsRealFailures() {
        // A dropped socket is what pending requests fail with — the single
        // most important thing that must still reach the user.
        #expect(!T3Error.connectionClosed(reason: nil).isCancellation)
        #expect(!T3Error.notConnected.isCancellation)
        #expect(!URLError(.timedOut).isCancellation)
        #expect(!URLError(.notConnectedToInternet).isCancellation)
        // Same numeric code, different domain: must not match.
        #expect(!NSError(domain: "SomeOtherDomain", code: NSURLErrorCancelled).isCancellation)
    }
}
