import Foundation

/// Cancellation is not a failure, and it reaches call sites in more than one
/// shape: `RpcConnection.request` throws `CancellationError` when its task is
/// interrupted (§2.4), `URLSession`'s async API reports the same condition as
/// `URLError.cancelled`, and Cocoa APIs use `NSUserCancelledError`. Anything
/// that has to tell "the user navigated away" apart from "this actually broke"
/// needs all three, so the test lives here once instead of being re-derived
/// (and re-forgotten) per call site.
extension Error {
    public var isCancellation: Bool {
        if self is CancellationError { return true }
        let nsError = self as NSError
        switch (nsError.domain, nsError.code) {
        case (NSURLErrorDomain, NSURLErrorCancelled), (NSCocoaErrorDomain, NSUserCancelledError):
            return true
        default:
            return false
        }
    }
}
