import Foundation

struct MobileServerConfiguration: Equatable, Sendable {
    let baseURL: URL
    let bearerSessionToken: String?
    let bootstrapCredential: String?

    init(baseURL: URL, bearerSessionToken: String? = nil, bootstrapCredential: String? = nil) {
        self.baseURL = baseURL
        self.bearerSessionToken = bearerSessionToken
        self.bootstrapCredential = bootstrapCredential
    }
}
