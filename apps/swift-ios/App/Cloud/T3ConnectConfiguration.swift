import Foundation

public struct T3ConnectConfiguration: Equatable, Sendable {
    public static let defaultClerkJWTTemplate = "t3-relay"

    public let clerkPublishableKey: String
    public let clerkJWTTemplate: String
    public let relayHTTPURL: URL

    public init(
        clerkPublishableKey: String,
        clerkJWTTemplate: String = Self.defaultClerkJWTTemplate,
        relayHTTPURL: URL
    ) {
        self.clerkPublishableKey = clerkPublishableKey
        self.clerkJWTTemplate = clerkJWTTemplate
        self.relayHTTPURL = relayHTTPURL
    }

    public static func resolve(bundle: Bundle = .main) -> T3ConnectConfigurationResolution {
        resolve(infoDictionary: bundle.infoDictionary ?? [:])
    }

    public static func resolve(
        infoDictionary: [String: Any]
    ) -> T3ConnectConfigurationResolution {
        let publishableKey = configuredString(
            infoDictionary["T3ConnectClerkPublishableKey"]
        )
        let relayHTTPValue = configuredString(infoDictionary["T3ConnectRelayHTTPURL"])
        let jwtTemplate = configuredString(infoDictionary["T3ConnectClerkJWTTemplate"])
            ?? defaultClerkJWTTemplate

        var missingKeys: [String] = []
        if publishableKey == nil { missingKeys.append("Clerk publishable key") }
        if relayHTTPValue == nil { missingKeys.append("relay HTTP URL") }
        guard missingKeys.isEmpty else {
            return .unavailable(
                reason: "This build is missing \(missingKeys.joined(separator: ", "))."
            )
        }

        guard
            let relayHTTPValue,
            let relayHTTPURL = URL(string: relayHTTPValue),
            relayHTTPURL.scheme?.lowercased() == "https",
            relayHTTPURL.host != nil
        else {
            return .unavailable(reason: "The T3 Connect relay HTTP URL must use HTTPS.")
        }
        return .available(
            T3ConnectConfiguration(
                clerkPublishableKey: publishableKey!,
                clerkJWTTemplate: jwtTemplate,
                relayHTTPURL: normalizedBaseURL(relayHTTPURL)
            )
        )
    }

    private static func configuredString(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else { return nil }
        return trimmed
    }

    private static func normalizedBaseURL(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        components.query = nil
        components.fragment = nil
        components.path = components.path.replacingOccurrences(
            of: #"/+$"#,
            with: "",
            options: .regularExpression
        )
        return components.url ?? url
    }
}

public enum T3ConnectConfigurationResolution: Equatable, Sendable {
    case available(T3ConnectConfiguration)
    case unavailable(reason: String)

    public var configuration: T3ConnectConfiguration? {
        guard case let .available(configuration) = self else { return nil }
        return configuration
    }
}
