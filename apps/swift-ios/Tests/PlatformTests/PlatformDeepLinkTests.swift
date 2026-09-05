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
    func opensNativeThreadLinksInsideTheApp() throws {
        let snapshot = Self.linkedSnapshot()
        let expected = PlatformRoute.thread(environmentID: "environment-1", threadID: "thread-7")

        for link in [
            "\(PlatformRoute.nativeScheme)://threads/environment-1/thread-7",
            "t3code://threads/environment-1/thread-7",
            "t3://threads/environment-1/thread-7",
            "https://app.t3.codes/environment-1/thread-7",
            "https://app.t3.codes/threads/thread-7?environment=environment-1",
        ] {
            let url = try #require(URL(string: link))
            #expect(
                PlatformInAppLinkRouter.route(for: url, in: snapshot) == expected,
                "Expected \(link) to open in the app"
            )
        }
    }

    @Test
    func opensThreadLinksByWireIdentifierWithoutAnEnvironment() throws {
        let snapshot = Self.linkedSnapshot()
        let url = try #require(URL(string: "t3code://threads/wire-thread-7"))

        #expect(
            PlatformInAppLinkRouter.route(for: url, in: snapshot)
                == .thread(environmentID: nil, threadID: "wire-thread-7")
        )
    }

    @Test
    func leavesLinksThisDeviceCannotShowToTheSystem() throws {
        let snapshot = Self.linkedSnapshot()

        for link in [
            // Nothing on this device matches the destination.
            "t3code://threads/environment-1/thread-missing",
            "t3code://threads/environment-missing/thread-7",
            "t3code://projects/environment-1/project-missing",
            "t3code://environments/environment-missing",
            "t3code://new-task?environment=environment-1&project=project-missing",
            // Trusted web pages that are not thread destinations.
            "https://app.t3.codes/docs/getting-started",
            "https://app.t3.codes/settings",
            // Ordinary links inside message content.
            "https://example.com/environment-1/thread-7",
            "mailto:someone@example.com",
        ] {
            let url = try #require(URL(string: link))
            #expect(
                PlatformInAppLinkRouter.route(for: url, in: snapshot) == nil,
                "Expected \(link) to keep its system behavior"
            )
        }
    }

    @Test
    func leavesPairingLinksToOnboarding() throws {
        let snapshot = Self.linkedSnapshot()
        let url = try #require(
            URL(string: "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3DPAIR")
        )

        #expect(PlatformInAppLinkRouter.route(for: url, in: snapshot) == nil)
    }

    @Test
    func opensProjectEnvironmentAndNewTaskLinksInsideTheApp() throws {
        let snapshot = Self.linkedSnapshot()

        let project = try #require(URL(string: "t3code://projects/environment-1/project-3"))
        #expect(
            PlatformInAppLinkRouter.route(for: project, in: snapshot)
                == .project(environmentID: "environment-1", projectID: "project-3")
        )

        let environment = try #require(URL(string: "t3code://environments/environment-1"))
        #expect(
            PlatformInAppLinkRouter.route(for: environment, in: snapshot)
                == .environment(id: "environment-1")
        )

        let newTask = try #require(
            URL(string: "t3code://new-task?environment=environment-1&project=project-3")
        )
        #expect(
            PlatformInAppLinkRouter.route(for: newTask, in: snapshot)
                == .newTask(environmentID: "environment-1", projectID: "project-3")
        )
    }

    private static func linkedSnapshot() -> FeatureSnapshot {
        let environment = FeatureEnvironment(
            id: "environment-1",
            name: "Environment 1",
            endpoint: "https://environment-1.example",
            isActive: true
        )
        let project = FeatureProject(
            id: "project-3",
            wireID: "wire-project-3",
            environmentID: environment.id,
            name: "Project 3",
            path: "/project-3"
        )
        let thread = FeatureThread(
            id: "thread-7",
            wireID: "wire-thread-7",
            projectID: project.id,
            environmentID: environment.id,
            title: "Thread 7"
        )
        return FeatureSnapshot(
            environments: [environment],
            projects: [project],
            threads: [thread]
        )
    }

    @Test
    func resolverRequiresEnvironmentForDuplicateWireIDs() throws {
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
            ) == nil
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
