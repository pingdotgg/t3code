import Foundation
import T3Kit

/// Pure selection + URL-building rules for mobile/Mac pairing, extracted from
/// `LiveBackend.mintMobilePairing` so the remote-vs-LAN decision is unit
/// testable without a running sidecar.
///
/// Preference order (mirrors the server's `buildServerAdvertisedEndpoints`
/// contract in apps/server/src/advertisedEndpoints.ts):
/// 1. The default public managed tunnel, or the optional private-network
///    fallback when the server advertises one.
/// 2. The LAN address fallback (`http://<lan-ip>:<port>/`), which still
///    requires the beyond-loopback bind gated by `MobileAccessPreference`.
enum PairingEndpointSelection {
    /// The server marks exactly one cross-network route as default: SurgeCode
    /// Cloud when linked, otherwise the optional Tailscale fallback.
    static func preferredRemoteEndpoint(
        _ endpoints: [AdvertisedEndpoint]?
    ) -> AdvertisedEndpoint? {
        endpoints?.first { endpoint in
            endpoint.isDefault == true
                && (endpoint.reachability == "public"
                    || endpoint.reachability == "private-network")
                && endpoint.status == "available"
                && endpoint.compatibility.desktopApp == "compatible"
        }
    }

    /// Builds the QR-able pairing URL from an advertised HTTP base
    /// (normalized with a trailing slash on the wire): path `/pair`, token in
    /// the fragment so it never appears in request logs — the same shape
    /// `buildPairingUrl` prints for headless `serve` (startupAccess.ts).
    static func pairingURL(httpBaseUrl: String, credential: String) -> URL? {
        guard let base = URL(string: httpBaseUrl), base.host != nil else { return nil }
        var components = URLComponents()
        components.scheme = base.scheme
        components.host = base.host
        components.port = base.port
        components.path = "/pair"
        components.fragment = "token=\(credential)"
        return components.url
    }
}
