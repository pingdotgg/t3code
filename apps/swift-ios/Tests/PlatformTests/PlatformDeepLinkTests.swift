import Foundation
import Testing
@testable import T3Code

@Suite("Platform deep links")
struct PlatformDeepLinkTests {
    @Test
    func parsesWidgetThreadRoute() throws {
        let route = try PlatformDeepLinkParser.parse(
            "t3code://threads/environment-1/thread-7"
        )

        #expect(route == .thread(environmentID: "environment-1", threadID: "thread-7"))
    }

    @Test
    func parsesProjectAndEnvironmentQueryRoutes() throws {
        #expect(
            try PlatformDeepLinkParser.parse("t3code://projects/project-7?environment=environment-1")
                == .project(environmentID: "environment-1", projectID: "project-7")
        )
        #expect(
            try PlatformDeepLinkParser.parse("t3code://environments/environment-2")
                == .environment(id: "environment-2")
        )
        #expect(
            try PlatformDeepLinkParser.parse("t3code://new-task?environment=environment-2&project=project-8")
                == .newTask(environmentID: "environment-2", projectID: "project-8")
        )
    }

    @Test
    func unwrapsPairingURL() throws {
        let route = try PlatformDeepLinkParser.parse(
            "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3DPAIR"
        )

        #expect(route == .connection(endpoint: "https://remote.example.com", token: "PAIR"))
    }

    @Test
    func parsesTrustedWebThreadRoute() throws {
        let route = try PlatformDeepLinkParser.parse(
            "https://app.t3.codes/environment-1/thread-7"
        )

        #expect(route == .thread(environmentID: "environment-1", threadID: "thread-7"))
    }

    @Test
    func rejectsUntrustedWebNavigationRoute() {
        #expect(throws: PlatformDeepLinkError.unsupportedURL) {
            try PlatformDeepLinkParser.parse("https://malicious.example/threads/env/thread")
        }
    }

    @Test
    func rejectsConnectionParametersFromUntrustedWebHosts() {
        #expect(throws: PlatformDeepLinkError.unsupportedURL) {
            try PlatformDeepLinkParser.parse(
                "https://malicious.example/connect?endpoint=https%3A%2F%2Fattacker.example&token=x"
            )
        }
    }

    @Test
    func routeURLsRoundTrip() throws {
        let routes: [PlatformRoute] = [
            .environment(id: "environment 1"),
            .project(environmentID: "environment 1", projectID: "project/1"),
            .thread(environmentID: "environment 1", threadID: "thread 1"),
            .newTask(environmentID: "environment 1", projectID: "project 1"),
            .connection(endpoint: "https://remote.example.com", token: "PAIR"),
        ]

        for route in routes {
            let url = try #require(route.url)
            #expect(url.scheme == PlatformRoute.nativeScheme)
            let parsed = try PlatformDeepLinkParser.parse(url)
            #expect(parsed == route, "Failed to round-trip \(route) through \(url.absoluteString)")
        }
    }

    @Test
    func acceptsLinksFromBothSwiftUIIdentitiesAndLegacyRoutes() throws {
        #expect(
            try PlatformDeepLinkParser.parse("t3code-swiftui://threads/environment/thread")
                == .thread(environmentID: "environment", threadID: "thread")
        )
        #expect(
            try PlatformDeepLinkParser.parse("t3code-swiftui-dev://threads/environment/thread")
                == .thread(environmentID: "environment", threadID: "thread")
        )
        #expect(
            try PlatformDeepLinkParser.parse("t3code://threads/environment/thread")
                == .thread(environmentID: "environment", threadID: "thread")
        )
        #expect(
            try PlatformDeepLinkParser.parse("t3://threads/environment/thread")
                == .thread(environmentID: "environment", threadID: "thread")
        )
    }

    @Test
    func clerkCallbackUsesCurrentAppIdentity() {
        #expect(T3ConnectAuthCallback.scheme == PlatformRoute.nativeScheme)
        #expect(
            T3ConnectAuthCallback.redirectURL
                == "\(PlatformRoute.nativeScheme)://clerk-callback"
        )
    }

    @Test
    func mailboxConsumesExactlyOnce() throws {
        let suiteName = "PlatformDeepLinkTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let mailbox = PlatformRouteMailbox(defaults: defaults, key: "pending")
        let route = PlatformRoute.thread(environmentID: "env", threadID: "thread")

        mailbox.put(route)

        #expect(mailbox.peek() == route)
        #expect(mailbox.take() == route)
        #expect(mailbox.take() == nil)
    }

    @Test
    func resolverScopesDuplicateWireIDsAndPrefersActiveEnvironment() throws {
        let active = FeatureEnvironment(
            id: "active",
            name: "Active",
            endpoint: "https://active.example",
            isActive: true
        )
        let passive = FeatureEnvironment(
            id: "passive",
            name: "Passive",
            endpoint: "https://passive.example"
        )
        let activeProject = FeatureProject(
            id: "project-active",
            wireID: "shared-project",
            environmentID: active.id,
            name: "Active project",
            path: "/active"
        )
        let passiveProject = FeatureProject(
            id: "project-passive",
            wireID: "shared-project",
            environmentID: passive.id,
            name: "Passive project",
            path: "/passive"
        )
        let activeThread = FeatureThread(
            id: "thread-active",
            wireID: "shared-thread",
            projectID: activeProject.id,
            environmentID: active.id,
            title: "Active thread"
        )
        let passiveThread = FeatureThread(
            id: "thread-passive",
            wireID: "shared-thread",
            projectID: passiveProject.id,
            environmentID: passive.id,
            title: "Passive thread"
        )
        let snapshot = FeatureSnapshot(
            environments: [active, passive],
            projects: [passiveProject, activeProject],
            threads: [passiveThread, activeThread]
        )

        #expect(
            PlatformRouteResolver.thread(
                in: snapshot,
                environmentID: nil,
                id: "shared-thread"
            )?.id == activeThread.id
        )
        #expect(
            PlatformRouteResolver.thread(
                in: snapshot,
                environmentID: passive.id,
                id: "shared-thread"
            )?.id == passiveThread.id
        )
        #expect(
            PlatformRouteResolver.project(
                in: snapshot,
                environmentID: passive.id,
                id: "shared-project"
            )?.id == passiveProject.id
        )
    }
}
