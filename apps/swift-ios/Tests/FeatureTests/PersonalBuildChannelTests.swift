import Foundation
import Testing
@testable import T3Code

@Suite("Personal build channel")
struct PersonalBuildChannelTests {
    private func info(channel: String? = nil) -> [String: Any] {
        var info: [String: Any] = [:]
        if let channel { info["T3BuildChannel"] = channel }
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
    func anUnrecognisedDeclaredChannelIsUnmarked() {
        let staging = info(channel: "staging")
        #expect(PersonalBuildChannel(info: staging) == .upstream)
    }

    @Test
    func anUndeclaredChannelIsUnmarked() {
        let undeclared = ["", "   ", "$(T3_BUILD_CHANNEL)"]
        for value in undeclared {
            #expect(PersonalBuildChannel(info: info(channel: value)) == .upstream)
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
