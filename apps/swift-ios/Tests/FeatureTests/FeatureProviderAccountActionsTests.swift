import Testing
@testable import T3Code

@MainActor
struct FeatureProviderAccountActionsTests {
    @Test func registryLogoutDenialDoesNotPreventChangingAccounts() throws {
        var provider = signedInProvider()
        provider.canLogout = false
        let auth = try authState(phase: "idle")
        let actions = FeatureProviderAccountActions(provider: provider, auth: auth)
        #expect(actions.isSignedIn)
        #expect(!actions.canSignOut)
        #expect(actions.canChangeAccount)

        provider.setup = ProviderSetupCapabilities(canAuthenticate: false, canInstall: true)
        provider.canLogout = true
        let external = FeatureProviderAccountActions(provider: provider, auth: auth)
        #expect(external.canSignOut)
        #expect(!external.canChangeAccount)
    }

    @Test func olderProvidersUseAuthenticationSupportOnlyWhenLogoutIsAbsent() {
        var provider = signedInProvider()
        #expect(FeatureProviderAccountActions(provider: provider, auth: nil).canSignOut)
        provider.setup = nil
        let missing = FeatureProviderAccountActions(provider: provider, auth: nil)
        #expect(!missing.canSignOut)
        #expect(missing.canChangeAccount)
        provider.canLogout = true
        #expect(FeatureProviderAccountActions(provider: provider, auth: nil).canSignOut)
    }

    @Test func activeSignInSuppressesAccountActionsAndUnknownStatusNeedsSuccess() throws {
        var provider = signedInProvider()
        let active = FeatureProviderAccountActions(provider: provider, auth: try authState(phase: "waiting"))
        #expect(!active.canSignOut)
        #expect(!active.canChangeAccount)

        provider.authStatus = "unknown"
        provider.isEnabled = false
        let unknown = FeatureProviderAccountActions(provider: provider, auth: try authState(phase: "idle"))
        #expect(!unknown.isSignedIn)
        #expect(!unknown.canSignOut)
        let succeeded = FeatureProviderAccountActions(provider: provider, auth: try authState(phase: "succeeded"))
        #expect(succeeded.isSignedIn)
        #expect(succeeded.canSignOut)
    }

    @Test func cachedProvidersPreserveLogoutCapabilityAndDecodeOlderRecords() throws {
        let legacy = signedInProvider()
        #expect(try JSONValue.encode(legacy).decode(FeatureProvider.self).canLogout == nil)
        for value in [false, true] {
            var provider = legacy
            provider.canLogout = value
            #expect(try JSONValue.encode(provider).decode(FeatureProvider.self).canLogout == value)
        }
    }

    private func signedInProvider() -> FeatureProvider {
        var provider = FeatureProvider(id: "registry", name: "Registry agent", driver: "acpRegistry")
        provider.authStatus = "authenticated"
        provider.isEnabled = true
        provider.isInstalled = true
        provider.setup = ProviderSetupCapabilities(canAuthenticate: true, canInstall: true)
        return provider
    }

    private func authState(phase: String) throws -> ProviderAuthState {
        try JSONValue.object([
            "instanceId": .string("registry"), "phase": .string(phase),
        ]).decode(ProviderAuthState.self)
    }
}
