import Foundation
import Testing
@testable import T3Code

@Suite("Thread destination links")
struct PlatformNestedDeepLinkTests {
    @Test
    func filePathsAndLinesSurviveAllLinkForms() throws {
        let expected = PlatformRoute.threadDestination(
            environmentID: "env", threadID: "thread",
            destination: .files(path: "src/my file.swift", line: 42)
        )
        for link in [
            "t3code://threads/env/thread/files/src/my%20file.swift?line=42",
            "https://app.t3.codes/env/thread/files/src/my%20file.swift?line=42",
            "https://app.t3.codes/threads/env/thread/files/src/my%20file.swift?line=42",
            "t3code://threads/thread/files/src/my%20file.swift?environment=env&line=42",
        ] {
            #expect(try PlatformDeepLinkParser.parse(link) == expected)
        }
        #expect(try PlatformDeepLinkParser.parse(#require(expected.url)) == expected)
    }

    @Test
    func nestedDestinationsSurviveMailboxAndURLRoundTrip() throws {
        let destinations: [FeatureThreadDestination] = [
            .files(path: nil, line: nil), .files(path: "src/a#b%.swift", line: 2),
            .terminal(sessionID: "terminal 2"), .review, .devices, .browser(tabID: "tab 2"), .git, .gitCommit, .gitBranches,
        ]
        let suite = "NestedDeepLinks.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let mailbox = PlatformRouteMailbox(defaults: defaults)
        for destination in destinations {
            let route = PlatformRoute.threadDestination(
                environmentID: "env", threadID: "thread", destination: destination
            )
            #expect(try PlatformDeepLinkParser.parse(#require(route.url)) == route)
            mailbox.put(route)
            #expect(mailbox.take() == route)
            #expect(mailbox.take() == nil)
        }
    }

    @Test
    func rejectsUnsafePathsAndUnknownSubroutesInsteadOfOpeningTheThread() {
        for suffix in [
            "files/%2E%2E/secrets", "files/src/%2E%2E/secrets", "files/%2Fetc/passwd",
            "files/src%5Csecret", "files/src%00x", "files/a?line=-1", "files/a?line=word",
            "terminal/extra", "git/delete", "unknown",
        ] {
            #expect(throws: (any Error).self) {
                try PlatformDeepLinkParser.parse("t3code://threads/env/thread/\(suffix)")
            }
            #expect(throws: (any Error).self) {
                try PlatformDeepLinkParser.parse("https://app.t3.codes/threads/env/thread/\(suffix)")
            }
        }
    }

    @Test
    func terminalSessionQueryIsCarried() throws {
        #expect(try PlatformDeepLinkParser.parse("t3://threads/env/thread/terminal?terminalId=shell-2")
                == .threadDestination(environmentID: "env", threadID: "thread",
                                      destination: .terminal(sessionID: "shell-2")))
    }
}
