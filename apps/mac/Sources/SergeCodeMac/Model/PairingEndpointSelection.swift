import Foundation
import T3Kit

/// Pure selection + URL-building rules for mobile/Mac pairing, extracted from
/// `LiveBackend.mintMobilePairing` so the tailnet-vs-LAN decision is unit
/// testable without a running sidecar.
///
/// Preference order (mirrors the server's `buildServerAdvertisedEndpoints`
/// contract in apps/server/src/advertisedEndpoints.ts):
/// 1. The default `private-network` endpoint (Tailscale serve) when the
///    server advertises one — reachable from anywhere on the tailnet, no LAN
///    bind required because `tailscale serve` proxies to loopback.
/// 2. The LAN address fallback (`http://<lan-ip>:<port>/`), which still
///    requires the beyond-loopback bind gated by `MobileAccessPreference`.
enum PairingEndpointSelection {
    /// The advertised endpoint pairing should prefer: the server marks the
    /// Tailscale entry — and only it — `isDefault: true`, with provider kind
    /// `private-network`. Requires `status == "available"` so a stale or
    /// degraded advertisement never produces an unreachable QR code.
    static func preferredTailnetEndpoint(
        _ endpoints: [AdvertisedEndpoint]?
    ) -> AdvertisedEndpoint? {
        endpoints?.first { endpoint in
            endpoint.isDefault == true
                && endpoint.provider.kind == "private-network"
                && endpoint.status == "available"
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
