import Foundation

enum MobileLaunchConfiguration {
    static func fromProcessInfo(_ processInfo: ProcessInfo = .processInfo) throws -> MobileServerConfiguration? {
        let environment = processInfo.environment
        guard let rawBaseURL = environment["T3_MOBILE_SERVER_URL"], !rawBaseURL.isEmpty else {
            return nil
        }
        guard let baseURL = URL(string: rawBaseURL) else {
            throw MobileSyncError.invalidBaseURL(rawBaseURL)
        }
        return MobileServerConfiguration(
            baseURL: baseURL,
            bearerSessionToken: environment["T3_MOBILE_BEARER_TOKEN"],
            bootstrapCredential: environment["T3_MOBILE_BOOTSTRAP_TOKEN"]
        )
    }
}
