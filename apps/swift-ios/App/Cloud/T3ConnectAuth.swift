import ClerkKit
import Foundation

public enum T3ConnectSignInProvider: String, CaseIterable, Identifiable, Sendable {
    case google
    case github

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .google: "Continue with Google"
        case .github: "Continue with GitHub"
        }
    }

    fileprivate var clerkProvider: OAuthProvider {
        switch self {
        case .google: .google
        case .github: .github
        }
    }
}

public struct T3ConnectAccount: Equatable, Sendable {
    public let id: String
    public let email: String?
    public let imageURL: URL?
}

public enum T3ConnectAuthError: LocalizedError, Sendable {
    case noSession

    public var errorDescription: String? {
        switch self {
        case .noSession:
            "Sign in to your T3 account to use T3 Connect."
        }
    }
}

enum T3ConnectAuthCallback {
    static let scheme = PlatformRoute.nativeScheme
    static let redirectURL = "\(scheme)://clerk-callback"
}

/// Small ClerkKit boundary. Clerk owns encrypted session persistence and the
/// ASWebAuthenticationSession callback; the app only asks for the relay JWT.
@MainActor
public final class T3ConnectClerkSession {
    private let clerk: Clerk
    private let jwtTemplate: String

    public init(configuration: T3ConnectConfiguration) {
        jwtTemplate = configuration.clerkJWTTemplate
        clerk = Clerk.configure(
            publishableKey: configuration.clerkPublishableKey,
            options: .init(
                redirectConfig: .init(
                    redirectUrl: T3ConnectAuthCallback.redirectURL,
                    callbackUrlScheme: T3ConnectAuthCallback.scheme
                )
            )
        )
    }

    public var account: T3ConnectAccount? {
        guard let user = clerk.user else { return nil }
        return T3ConnectAccount(
            id: user.id,
            email: user.primaryEmailAddress?.emailAddress,
            imageURL: URL(string: user.imageUrl)
        )
    }

    public var isLoaded: Bool { clerk.isLoaded }

    public func refresh() async throws {
        _ = try await clerk.refreshClient()
    }

    public func signIn(with provider: T3ConnectSignInProvider) async throws {
        _ = try await clerk.auth.signInWithOAuth(provider: provider.clerkProvider)
        _ = try await clerk.refreshClient()
    }

    public func signOut() async throws {
        try await clerk.auth.signOut()
    }

    public func relayToken() async throws -> String {
        let token = try await clerk.auth.getToken(
            .init(template: jwtTemplate, expirationBuffer: 20)
        )
        guard let token, !token.isEmpty else { throw T3ConnectAuthError.noSession }
        return token
    }
}
