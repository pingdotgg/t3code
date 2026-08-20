import Foundation
import Testing
@testable import T3Code

@Suite("Personal build channel")
struct PersonalBuildChannelTests {
    private func info(channel: String? = nil, bundleID: String? = nil) -> [String: Any] {
        var info: [String: Any] = [:]
        if let channel { info["T3BuildChannel"] = channel }
        if let bundleID { info["CFBundleIdentifier"] = bundleID }
        return info
    }

    @Test
    func declaredChannelWins() {
        #expect(PersonalBuildChannel(info: info(channel: "dev")) == .dev)
        #expect(PersonalBuildChannel(info: info(channel: "test")) == .test)
        #expect(PersonalBuildChannel(info: info(channel: "upstream")) == .upstream)
        #expect(PersonalBuildChannel(info: info(channel: " TEST ")) == .test)
    }

    @Test
    func declaredChannelOverridesTheBundleIdentifier() {
        let forcedUpstream = info(channel: "upstream", bundleID: "com.example.someones.dev-branch")
        #expect(PersonalBuildChannel(info: forcedUpstream) == .upstream)

        let forcedTest = info(channel: "test", bundleID: "com.t3tools.t3code.swiftui.dev")
        #expect(PersonalBuildChannel(info: forcedTest) == .test)
    }

    @Test
    func anUnrecognisedDeclaredChannelOverridesTheBundleIdentifier() {
        let staging = info(channel: "staging", bundleID: "com.example.someones.dev-branch")
        #expect(PersonalBuildChannel(info: staging) == .upstream)
    }

    @Test
    func anUndeclaredChannelDoesNotInferFromTheBundleIdentifier() {
        let undeclared = ["", "   ", "$(T3_BUILD_CHANNEL)"]
        let bundleIdentifiers = ["com.example.someones.dev-branch", "com.t3tools.t3code.swiftui"]
        for value in undeclared {
            for bundleIdentifier in bundleIdentifiers {
                let customBundle = info(channel: value, bundleID: bundleIdentifier)
                #expect(PersonalBuildChannel(info: customBundle) == .upstream)
            }
        }
    }

    @Test
    func onlyThePersonalChannelsCarryATitleSuffix() {
        #expect(PersonalBuildChannel.dev.titleSuffix == "Dev")
        #expect(PersonalBuildChannel.test.titleSuffix == "Test")
        #expect(PersonalBuildChannel.upstream.titleSuffix == nil)
    }

    @Test
    func theTwoPersonalChannelsAreVisuallyDistinct() {
        #expect(PersonalBuildChannel.dev.color != PersonalBuildChannel.test.color)
    }

    @Test
    func anEmptyInfoDictionaryIsTreatedAsUpstream() {
        #expect(PersonalBuildChannel(info: nil) == .upstream)
        #expect(PersonalBuildChannel(info: [:]) == .upstream)
    }
}
