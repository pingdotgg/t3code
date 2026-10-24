import Testing
@testable import T3Code

struct ProviderSetupTests {
    @Test func defaultAntigravityToggleUsesOnlySupportedSettings() {
        let current: JSONValue = .object(["providerInstances": .object([:])])
        let patch = ProviderSettingsPatch.enabled(settings: current, instanceID: "antigravity", driver: "antigravity", enabled: true)
        #expect(patch["providers"] == nil)
        #expect(patch["providerInstances"]?["antigravity"]?["enabled"] == .bool(true))
        let legacy: JSONValue = .object(["providers": .object(["antigravity": .object(["gcpProject": .string("work")])])])
        let migrated = ProviderSettingsPatch.enabled(settings: legacy, instanceID: "antigravity", driver: "antigravity", enabled: true)
        #expect(migrated["providers"]?["antigravity"]?["enabled"] == .bool(false))
        #expect(migrated["providerInstances"]?["antigravity"]?["config"]?["gcpProject"] == .string("work"))
    }

    @Test func logoutCapabilityPreservesFalseAndOlderServerAbsence() throws {
        let legacy = try JSONValue.object(["status": .string("authenticated")]).decode(ServerProviderAuthSnapshot.self)
        #expect(legacy.canLogout == nil)
        for value in [false, true] {
            let auth = try JSONValue.object([
                "status": .string("authenticated"), "canLogout": .bool(value),
            ]).decode(ServerProviderAuthSnapshot.self)
            #expect(auth.canLogout == value)
        }
    }

    @Test func installedRegistryProvidersDiscoverMethodsWithoutAdvertisedSignIn() throws {
        let external = ProviderSetupCapabilities(canAuthenticate: false, canInstall: true)
        #expect(ProviderAccountDiscovery.isSupported(driver: "acpRegistry", installed: true, setup: external))
        #expect(ProviderAccountDiscovery.isSupported(driver: "acpRegistry", installed: true, setup: nil))
        #expect(!ProviderAccountDiscovery.isSupported(driver: "acpRegistry", installed: false, setup: external))
        #expect(!ProviderAccountDiscovery.isSupported(driver: "codex", installed: true, setup: external))
        #expect(ProviderAccountDiscovery.isSupported(driver: "codex", installed: true,
            setup: ProviderSetupCapabilities(canAuthenticate: true, canInstall: false)))

        let discovering = try JSONValue.object([
            "instanceId": .string("registry-work"), "phase": .string("idle"),
        ]).decode(ProviderAuthState.self)
        #expect(ProviderAccountDiscovery.isDiscovering(driver: "acpRegistry", auth: discovering))
        #expect(!ProviderAccountDiscovery.isDiscovering(driver: "codex", auth: discovering))
        let externalState = try JSONValue.object([
            "instanceId": .string("registry-work"), "phase": .string("idle"), "methods": .array([]),
        ]).decode(ProviderAuthState.self)
        #expect(!ProviderAccountDiscovery.isDiscovering(driver: "acpRegistry", auth: externalState))
        #expect(ProviderAccountDiscovery.needsExternalSetup(driver: "acpRegistry", setup: nil, auth: externalState))
        let ready = try JSONValue.object([
            "instanceId": .string("registry-work"), "phase": .string("idle"),
            "methods": .array([.object(["id": .string("device"), "name": .string("Device code"), "type": .string("agent")])]),
        ]).decode(ProviderAuthState.self)
        #expect(!ProviderAccountDiscovery.isDiscovering(driver: "acpRegistry", auth: ready))
        #expect(!ProviderAccountDiscovery.needsExternalSetup(driver: "acpRegistry", setup: nil, auth: ready))
    }

    @Test func providerSetupDocumentationSurvivesDecoding() throws {
        let setup = try JSONValue.object([
            "canAuthenticate": .bool(false), "canInstall": .bool(true),
            "documentationUrl": .string("https://example.test/setup"),
        ]).decode(ProviderSetupCapabilities.self)
        #expect(setup.documentationUrl == "https://example.test/setup")
    }

    @Test func updateDiscoveryPreservesTheEnvironmentReleaseChannel() {
        let releases = [
            EnvironmentReleaseIndex.Release(tag_name: "v0.0.44-nightly.20260930.10", draft: false),
            EnvironmentReleaseIndex.Release(tag_name: "v0.0.44-preview.20260930.9", draft: false),
            EnvironmentReleaseIndex.Release(tag_name: "v0.0.45", draft: true),
            EnvironmentReleaseIndex.Release(tag_name: "v0.0.44", draft: false),
        ]
        #expect(EnvironmentReleaseIndex.newest(releases, for: "0.0.43") == "0.0.44")
        #expect(EnvironmentReleaseIndex.newest(releases, for: "0.0.43-preview.20260920.1") == "0.0.44-preview.20260930.9")
        #expect(EnvironmentReleaseIndex.newest(releases, for: "0.0.43-nightly.20260920.1") == "0.0.44-nightly.20260930.10")
    }

    @Test func deviceCodeAndManagedCredentialFieldsDecode() throws {
        let state = try JSONValue.object([
            "instanceId": .string("work"), "phase": .string("waiting"), "flowId": .string("flow"),
            "credentialOwner": .string("t3"),
            "methods": .array([.object(["id": .string("device"), "name": .string("Device code"), "type": .string("agent")])]),
            "interaction": .object(["type": .string("deviceCode"), "id": .string("step"),
                "url": .string("https://example.test/activate"), "userCode": .string("ABCD")]),
        ]).decode(ProviderAuthState.self)
        #expect(state.methods?.first?.id == "device")
        #expect(state.interaction?.userCode == "ABCD")
        #expect(state.credentialOwner == "t3")
        let response = ProviderSetupAction.respond(flowID: "flow", interactionID: "step",
            response: .object(["type": .string("browser"), "action": .string("accept")]))
        #expect(response.method == "provider.auth.respond")
        #expect(response.payload(instanceID: "work")["interactionId"] == .string("step"))
        #expect(ProviderSetupAction.signInMethod("device").payload(instanceID: "work")["methodId"] == .string("device"))
    }

    @Test func enabledPatchPreservesOtherInstancesAndConfiguration() {
        let settings: JSONValue = .object([
            "providerInstances": .object([
                "other": .object(["driver": .string("codex")]),
                "google-work": .object([
                    "driver": .string("antigravity"), "displayName": .string("Work"),
                    "config": .object(["enabled": .bool(false), "gcpProject": .string("work")]),
                ]),
            ]),
        ])
        let patch = ProviderSettingsPatch.enabled(settings: settings, instanceID: "google-work", driver: "antigravity", enabled: true)
        #expect(patch["providerInstances"]?["other"] == settings["providerInstances"]?["other"])
        #expect(patch["providerInstances"]?["google-work"]?["displayName"] == .string("Work"))
        #expect(patch["providerInstances"]?["google-work"]?["enabled"] == .bool(true))
        #expect(patch["providerInstances"]?["google-work"]?["config"]?["enabled"] == nil)
        #expect(patch["providerInstances"]?["google-work"]?["config"]?["gcpProject"] == .string("work"))
    }

    @Test func callbackIsSentOnlyWithTheMatchingFlow() {
        let action = ProviderSetupAction.completeSignIn(flowID: "flow", callbackURL: "https://example.test/callback?code=test")
        #expect(action.method == "provider.auth.complete")
        #expect(action.payload(instanceID: "work")["flowId"] == .string("flow"))
        #expect(action.payload(instanceID: "work")["instanceId"] == .string("work"))
        #expect(ProviderSetupAction.signIn.payload(instanceID: "work")["callbackUrl"] == nil)
    }
}
