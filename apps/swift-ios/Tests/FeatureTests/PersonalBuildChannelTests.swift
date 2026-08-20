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
        let forcedUpstream = info(channel: "upstream", bundleID: "com.saphid.t3code.swiftui.dev")
        #expect(PersonalBuildChannel(info: forcedUpstream) == .upstream)

        let forcedTest = info(channel: "test", bundleID: "com.t3tools.t3code.swiftui.dev")
        #expect(PersonalBuildChannel(info: forcedTest) == .test)
    }

    @Test
    func anUnrecognisedDeclaredChannelOverridesTheBundleIdentifier() {
        let staging = info(channel: "staging", bundleID: "com.saphid.t3code.swiftui.dev")
        #expect(PersonalBuildChannel(info: staging) == .upstream)
    }

    @Test
    func anUndeclaredChannelFallsBackToTheBundleIdentifier() {
        let undeclared = ["", "   ", "$(T3_BUILD_CHANNEL)"]
        for value in undeclared {
            let dev = info(channel: value, bundleID: "com.saphid.t3code.swiftui.dev")
            #expect(PersonalBuildChannel(info: dev) == .dev, "\(value) should not mark the build")

            let test = info(channel: value, bundleID: "com.alxs.t3code.typed-swiftui.dev")
            #expect(PersonalBuildChannel(info: test) == .test, "\(value) should not mark the build")
        }
    }

    @Test
    func bundleIdentifierInferenceRecognisesThePersonalPublications() {
        let expected: [(String?, PersonalBuildChannel)] = [
            ("com.saphid.t3code.swiftui.dev", .dev),
            ("com.saphid.t3code.swiftui.dev.widgets", .dev),
            ("com.alxs.t3code.typed-swiftui.dev", .test),
            ("com.alxs.t3code.typed-swiftui.dev.sharing", .test),
            ("com.t3tools.t3code.swiftui.dev", .upstream),
            ("com.t3tools.t3code.swiftui", .upstream),
            (nil, .upstream),
        ]

        for (bundleID, channel) in expected {
            #expect(
                PersonalBuildChannel(info: info(bundleID: bundleID)) == channel,
                "\(bundleID ?? "no bundle id") should resolve to \(channel.rawValue)"
            )
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
