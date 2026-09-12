import Testing
@testable import T3Code

struct ProviderSetupTests {
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
