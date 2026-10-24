import Foundation
import Testing
@testable import T3Code

@Suite("Route-independent cached reads")
@MainActor
struct EnvironmentRouteCacheTests {
    @Test func selectingVerifiedRouteKeepsSameLeaseAndShell() async throws {
        let directory = routeTestDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ClientReadCache(directoryURL: directory)
        let environment = routeFixture(hosts: ["direct.example", "relay.example"])
        let firstLease = try await cache.activate(.init(environment))
        let shell = multiEnvironmentShell(projectID: "project", threadID: "thread", title: "Saved")
        await cache.record(shell: shell, lease: firstLease)
        let changedRoute = environment.selectingRoute(environment.routes[1])
        let secondLease = try await cache.activate(.init(changedRoute))
        #expect(secondLease == firstLease)
        #expect(await cache.shell(for: secondLease) == shell)
    }

    @Test func legacyOriginCacheMigratesOnlyWithMatchingVerifiedIdentity() async throws {
        for matching in [true, false] {
            let directory = routeTestDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var environment = routeFixture()
            let legacyFingerprint = ClientReadCache.Scope.fingerprint([
                environment.httpBaseURL.absoluteString, environment.webSocketBaseURL.absoluteString, environment.kind.rawValue,
            ].joined(separator: "\u{0}"))
            let shell = multiEnvironmentShell(projectID: "project", threadID: "thread", title: "Legacy")
            let value = JSONValue.object([
                "version": .number(1),
                "scope": .object([
                    "environmentID": .string(matching ? environment.id : "different-environment"),
                    "endpointFingerprint": .string(legacyFingerprint), "preference": .string("auto"),
                ]),
                "shell": try JSONValue.encode(shell), "histories": .object([:]),
                "savedAt": try JSONValue.encode(Date()),
            ])
            let file = directory.appendingPathComponent(ClientReadCache.Scope.fingerprint(environment.id) + ".json")
            try JSONEncoder.t3.encode(value).write(to: file)
            let cache = ClientReadCache(directoryURL: directory)
            environment = environment.selectingRoute(environment.routes[0])
            let lease = try await cache.activate(.init(environment))
            #expect(await cache.shell(for: lease) == (matching ? shell : nil))
        }
    }

    @Test func unknownAddressAndOtherEnvironmentCannotReuseVerifiedCache() async throws {
        let directory = routeTestDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ClientReadCache(directoryURL: directory)
        let environment = routeFixture()
        let lease = try await cache.activate(.init(environment))
        let shell = multiEnvironmentShell(projectID: "project", threadID: "thread", title: "Saved")
        await cache.record(shell: shell, lease: lease)
        var unchecked = environment
        unchecked.httpBaseURL = URL(string: "https://unknown.example/")!
        let changed = try await cache.activate(.init(unchecked))
        #expect(await cache.shell(for: changed) == nil)
        #expect(changed != lease)
    }
}
