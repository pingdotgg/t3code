import Foundation

struct FeatureWebhookAddress: Equatable {
    let address: String
    let copyable: Bool
    let note: String?

    init(endpoint: ScheduledTaskWebhookEndpoint, httpBaseURL: String?) {
        if let url = endpoint.url {
            address = url
            copyable = true
            note = nil
        } else if let httpBaseURL, let base = URL(string: httpBaseURL),
                  ["http", "https"].contains(base.scheme?.lowercased() ?? ""), base.host != nil,
                  let url = URL(string: endpoint.path, relativeTo: base)?.absoluteURL {
            address = url.absoluteString
            copyable = true
            let host = url.host?.lowercased() ?? ""
            let local = host == "localhost" || host.hasSuffix(".localhost") || host == "[::1]"
                || host == "::1" || host.hasPrefix("127.")
            note = local
                ? "Only this computer can call this address. Link T3 Connect for a public URL."
                : "Works wherever this environment is reachable, including over Tailscale. Link T3 Connect for a public URL."
        } else {
            address = endpoint.path
            copyable = false
            note = "Link this environment to T3 Connect for a public URL."
        }
    }
}
