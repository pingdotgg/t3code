import Foundation

/// Detects the macOS Local Network privacy (TCC) denial that desktop-to-
/// desktop pairing hits when this app's Local Network grant has been
/// silently revoked (e.g. its code signature changed on rebuild, see
/// `scripts/make-app.sh`). The failure surfaces to URLSession as plain
/// NSURLErrorDomain -1009 ("The Internet connection appears to be
/// offline") — indistinguishable at a glance from a real connectivity
/// problem — wrapping an NWError whose description mentions "Local
/// network prohibited", and it never re-prompts the user.
public enum LocalNetworkDenial {
    /// - Parameters:
    ///   - error: the transport error thrown by `URLSession`.
    ///   - url: the request URL that failed, if known.
    public static func matches(_ error: Error, url: URL?) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return false }
        guard nsError.code == URLError.notConnectedToInternet.rawValue
            || nsError.code == URLError.cannotConnectToHost.rawValue
        else {
            return false
        }

        if debugDescriptionChain(nsError).localizedCaseInsensitiveContains("Local network prohibited") {
            return true
        }
        // The host heuristic only applies to -1009: this Mac reporting
        // "offline" against a private-range peer is the denial in disguise.
        // -1004 (cannotConnectToHost) to a private host without the
        // prohibited marker above is the everyday "peer's server isn't
        // running / connection refused" case — not a TCC denial.
        guard nsError.code == URLError.notConnectedToInternet.rawValue else { return false }
        if let host = url?.host, isLikelyLocalNetworkHost(host) {
            return true
        }
        return false
    }

    /// Walks `NSUnderlyingErrorKey` (URLError/NWError chains nest one level
    /// per network layer) so the "Local network prohibited" string embedded
    /// deep in the NWPath description is still found.
    private static func debugDescriptionChain(_ error: NSError) -> String {
        var text = error.debugDescription
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            text += " " + debugDescriptionChain(underlying)
        }
        return text
    }

    private static func isLikelyLocalNetworkHost(_ host: String) -> Bool {
        if host.lowercased().hasSuffix(".local") { return true }
        return isPrivateIPv4(host)
    }

    private static func isPrivateIPv4(_ host: String) -> Bool {
        let octets = host.split(separator: ".").compactMap { UInt8($0) }
        guard octets.count == 4 else { return false }
        switch octets[0] {
        case 10:
            return true
        case 172:
            return (16...31).contains(octets[1])
        case 192:
            return octets[1] == 168
        default:
            return false
        }
    }
}
