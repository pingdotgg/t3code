import XCTest
@testable import T3Code

final class GitHubRoutingTests: XCTestCase {
    func testBothEndpointsMustOptInAndWritesNeedBothWriteGrants() throws {
        let origin = environment("origin")
        let destination = environment("destination")
        let sourceGrant = try grant(origin, .readWrite)
        let readGrant = try grant(destination, .read)
        XCTAssertFalse(GitHubRoutingGrant.allowed(origin: origin, destination: destination, grants: [sourceGrant], write: false))
        XCTAssertTrue(GitHubRoutingGrant.allowed(origin: origin, destination: destination, grants: [sourceGrant, readGrant], write: false))
        XCTAssertFalse(GitHubRoutingGrant.allowed(origin: origin, destination: destination, grants: [sourceGrant, readGrant], write: true))
        XCTAssertTrue(GitHubRoutingGrant.allowed(origin: origin, destination: destination,
            grants: [sourceGrant, try grant(destination, .readWrite)], write: true))
    }

    func testSavedGrantDoesNotMoveToChangedEndpointOrDisabledEnvironment() throws {
        let original = environment("server")
        let saved = try grant(original, .readWrite)
        var changed = original
        changed.httpBaseURL = URL(string: "https://other.example")!
        XCTAssertEqual(GitHubRoutingGrant.permission(for: changed, grants: [saved]), .off)
        changed = original
        changed.webSocketBaseURL = URL(string: "wss://other.example/ws")!
        XCTAssertEqual(GitHubRoutingGrant.permission(for: changed, grants: [saved]), .off)
        changed = original
        changed.isEnabled = false
        let source = environment("source")
        XCTAssertFalse(GitHubRoutingGrant.allowed(origin: source, destination: changed,
            grants: [try grant(source, .readWrite), saved], write: false))
    }

    func testRoutedReferenceCarriesHostAndAccountGuard() throws {
        let ref = PullRequestRef(projectId: "origin-project", repository: "org/repo", number: 2,
            host: "github.example.com", expectedAccountId: "account", allowStale: false)
        let json = try JSONValue.encode(ref)
        XCTAssertEqual(json["host"], .string("github.example.com"))
        XCTAssertEqual(json["expectedAccountId"], .string("account"))
        XCTAssertEqual(json["allowStale"], .bool(false))
    }

    private func environment(_ id: String) -> Environment {
        Environment(id: id, label: id, httpBaseURL: URL(string: "https://\(id).example")!,
            webSocketBaseURL: URL(string: "wss://\(id).example/ws")!)
    }

    private func grant(_ environment: Environment, _ permission: GitHubRoutingPermission) throws -> GitHubRoutingGrant {
        GitHubRoutingGrant(environmentID: environment.id,
            connectionKey: try XCTUnwrap(GitHubRoutingGrant.connectionKey(environment)), permission: permission)
    }
}
