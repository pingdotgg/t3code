import AppIntents
import CryptoKit
import Foundation
import Security
import Testing
@testable import T3IntentsCore

private final class MockEnvironmentClient: T3EnvironmentOperating, @unchecked Sendable {
  var lastLaunched: (environmentId: String, projectId: String, title: String?, message: String?, mode: String)?
  var lastMessage: (environmentId: String, threadId: String, text: String, mode: String)?
  var lastCommand: (environmentId: String, payload: [String: AnySendable])?

  func launchThread(
    environmentId: String,
    projectId: String,
    title: String?,
    message: String?,
    interactionMode: String
  ) async throws -> T3LaunchThreadResponse {
    lastLaunched = (environmentId, projectId, title, message, interactionMode)
    return T3LaunchThreadResponse(
      threadId: "thread-new",
      projectId: projectId,
      title: title ?? "Started Task",
      resumed: false,
      sequence: 12
    )
  }

  func sendMessage(
    environmentId: String,
    threadId: String,
    text: String,
    mode: String
  ) async throws -> T3SendMessageResponse {
    lastMessage = (environmentId, threadId, text, mode)
    return T3SendMessageResponse(
      threadId: threadId,
      messageId: "msg-1",
      runId: "run-1",
      delivery: "steered"
    )
  }

  func dispatchCommand(
    environmentId: String,
    payload: [String: AnySendable]
  ) async throws -> T3DispatchCommandResponse {
    lastCommand = (environmentId, payload)
    return T3DispatchCommandResponse(sequence: 42)
  }
}

private final class InMemoryCredentials: T3CredentialProviding, @unchecked Sendable {
  private var records: [String: T3AuthCredentialRecord] = [:]

  func credential(for environmentId: String) -> T3AuthCredentialRecord? {
    records[environmentId]
  }

  func saveCredentials(_ credentials: [T3AuthCredentialRecord]) {
    for record in credentials {
      records[record.environmentId] = record
    }
  }

  func removeCredential(for environmentId: String) {
    records.removeValue(forKey: environmentId)
  }

  func clearAllCredentials() {
    records.removeAll()
  }
}

private struct FailingCredentials: T3CredentialProviding {
  func credential(for environmentId: String) -> T3AuthCredentialRecord? { nil }
  func saveCredentials(_ credentials: [T3AuthCredentialRecord]) throws {
    throw T3KeychainError(status: errSecInteractionNotAllowed)
  }
  func removeCredential(for environmentId: String) throws {
    throw T3KeychainError(status: errSecInteractionNotAllowed)
  }
  func clearAllCredentials() throws {
    throw T3KeychainError(status: errSecInteractionNotAllowed)
  }
}

private func makeTempStore() -> T3IndexStore {
  let dir = FileManager.default.temporaryDirectory
    .appendingPathComponent("t3-intents-tests-\(UUID().uuidString)", isDirectory: true)
  return T3IndexStore(databaseURL: dir.appendingPathComponent("index.sqlite"))
}

/// Answers the environment descriptor as `descriptorEnvironmentId` and records every request.
private final class StubEnvironmentProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var descriptorEnvironmentId = "env-1"
  nonisolated(unsafe) static var requests: [URLRequest] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.requests.append(request)
    let isDescriptor = request.url?.path == "/.well-known/t3/environment"
    let body = isDescriptor
      ? #"{"environmentId":"\#(Self.descriptorEnvironmentId)"}"#
      : #"{"sequence":7}"#
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

private func makeStubbedClient() -> T3ServerClient {
  let credentials = InMemoryCredentials()
  credentials.saveCredentials([
    T3AuthCredentialRecord(
      environmentId: "env-1",
      httpBaseUrl: "http://192.168.1.20:3773",
      accessToken: "secret-token",
      authScheme: "Bearer"
    ),
  ])
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [StubEnvironmentProtocol.self]
  return T3ServerClient(credentials: credentials, session: URLSession(configuration: configuration))
}

@Suite("T3IntentsCore")
struct T3IntentsCoreTests {
  @Test("Applies deltas, searches projects and threads, and cascades environment removal")
  func storeDeltaAndCascadeDelete() throws {
    let store = makeTempStore()
    let env = T3EnvironmentRecord(
      id: "env-1",
      label: "Mac Studio",
      httpBaseUrl: "http://127.0.0.1:3773",
      isLocal: true,
      isConnected: true,
      updatedAt: "2026-09-10T12:00:00.000Z"
    )
    let project = T3ProjectRecord(
      id: "env-1:proj-1",
      environmentId: "env-1",
      projectId: "proj-1",
      name: "t3code",
      workspaceRoot: "/Users/dev/t3code",
      repositoryIdentity: "github.com/pingdotgg/t3code",
      branch: "main",
      updatedAt: "2026-09-10T12:00:00.000Z",
      deepLinkUrl: "t3code://new?environmentId=env-1&projectId=proj-1"
    )
    let thread = T3ThreadRecord(
      id: "env-1:thread-1",
      environmentId: "env-1",
      threadId: "thread-1",
      projectId: "proj-1",
      projectName: "t3code",
      title: "Fix Siri indexing",
      branch: "feat/siri",
      status: "waiting",
      hasPendingRequest: true,
      pendingRequestSummary: "Command approval required",
      isPinned: true,
      isSettled: false,
      isSnoozed: false,
      snoozedUntil: nil,
      lastMessagePreview: "Ready to run tests",
      providerLabel: "codex",
      modelLabel: "gpt-5.4",
      updatedAt: "2026-09-10T12:00:00.000Z",
      deepLinkUrl: "t3code://threads/env-1/thread-1"
    )

    let diff = try store.applyDelta(
      T3IndexDelta(
        environments: [env],
        upsertedProjects: [project],
        upsertedThreads: [thread]
      )
    )
    #expect(diff.upsertedProjects.count == 1)
    #expect(diff.upsertedThreads.count == 1)
    #expect(store.searchProjects(matching: "t3code").map(\.id) == ["env-1:proj-1"])
    #expect(store.searchThreads(matching: "siri").map(\.id) == ["env-1:thread-1"])

    let removed = try store.removeEnvironment(environmentId: "env-1")
    #expect(removed.removedProjectIds == ["env-1:proj-1"])
    #expect(removed.removedThreadIds == ["env-1:thread-1"])
    #expect(store.allEnvironments().isEmpty)
    #expect(store.allProjects().isEmpty)
    #expect(store.allThreads().isEmpty)
  }

  @Test("A replace-all delta drops records retained from an earlier launch")
  func replaceAllReconcilesRetainedRecords() throws {
    let store = makeTempStore()
    let env = T3EnvironmentRecord(
      id: "env-1",
      label: "Mac",
      httpBaseUrl: nil,
      isLocal: true,
      isConnected: true,
      updatedAt: "2026-09-10T12:00:00.000Z"
    )
    let kept = makeThread(id: "thread-kept")
    let stale = makeThread(id: "thread-stale")
    try store.applyDelta(T3IndexDelta(environments: [env], upsertedThreads: [kept, stale]))
    #expect(store.lastSyncedAt() != nil)

    let plan = try store.applyDelta(
      T3IndexDelta(environments: [env], upsertedThreads: [kept], replaceAll: true)
    )
    #expect(plan.removedThreadIds == ["env-1:thread-stale"])
    #expect(store.allThreads().map(\.id) == ["env-1:thread-kept"])
  }

  @Test("A seeded launch record never overwrites state the host already synced")
  func seedKeepsSyncedState() throws {
    let store = makeTempStore()
    try store.upsertThreadRecord(makeThread(id: "thread-1", status: "waiting"))
    try store.insertThreadRecordIfAbsent(makeThread(id: "thread-1", status: "running"))
    #expect(store.thread(id: "env-1:thread-1")?.status == "waiting")
  }

  @Test("Reports Keychain failures so the host keeps retrying credential writes and clears")
  func keychainFailuresPropagate() async throws {
    let runtime = T3IntentsRuntime(store: makeTempStore(), credentials: FailingCredentials())
    #expect(throws: T3KeychainError.self) {
      try runtime.syncAuthCredentialsJSON("[]")
    }
    await #expect(throws: T3KeychainError.self) {
      try await runtime.clearIndex()
    }
  }

  @Test("A disconnected environment's cached status is never presented as fresh")
  func freshnessIsPerEnvironment() throws {
    let store = makeTempStore()
    #expect(T3StatusFreshness.of(environmentId: "env-1", in: store) == .neverSynced)
    let connected = T3EnvironmentRecord(
      id: "env-1",
      label: "Mac",
      httpBaseUrl: nil,
      isLocal: true,
      isConnected: true,
      updatedAt: "2026-09-10T12:00:00.000Z"
    )
    let offline = T3EnvironmentRecord(
      id: "env-2",
      label: "Studio",
      httpBaseUrl: "http://192.168.1.30:3773",
      isLocal: false,
      isConnected: false,
      updatedAt: "2026-09-10T12:00:00.000Z"
    )
    try store.applyDelta(T3IndexDelta(environments: [connected, offline]))

    #expect(T3StatusFreshness.of(environmentId: "env-1", in: store) == .fresh)
    #expect(T3StatusFreshness.of(environmentId: "env-2", in: store) == .environmentOffline(label: "Studio"))
    let later = Date().addingTimeInterval(T3StatusFreshness.staleAfter + 60)
    guard case .stale = T3StatusFreshness.of(environmentId: "env-1", in: store, now: later) else {
      Issue.record("Expected an old sync to read as stale")
      return
    }
  }

  private func makeThread(id: String, status: String = "idle") -> T3ThreadRecord {
    T3ThreadRecord(
      id: "env-1:\(id)",
      environmentId: "env-1",
      threadId: id,
      projectId: "proj-1",
      projectName: "t3code",
      title: id,
      branch: nil,
      status: status,
      hasPendingRequest: false,
      pendingRequestSummary: nil,
      isPinned: false,
      isSettled: false,
      isSnoozed: false,
      snoozedUntil: nil,
      lastMessagePreview: nil,
      providerLabel: nil,
      modelLabel: nil,
      updatedAt: "2026-09-10T12:00:00.000Z",
      deepLinkUrl: "t3code://threads/env-1/\(id)"
    )
  }

  @Test("Never sends a saved credential to an address that answers as another environment")
  func verifiesEnvironmentBeforeAuthorizing() async throws {
    let client = makeStubbedClient()

    StubEnvironmentProtocol.requests = []
    StubEnvironmentProtocol.descriptorEnvironmentId = "env-other"
    await #expect(throws: T3IntentError.self) {
      _ = try await client.dispatchCommand(environmentId: "env-1", payload: ["type": .string("thread.pin")])
    }
    #expect(StubEnvironmentProtocol.requests.map { $0.url?.path } == ["/.well-known/t3/environment"])
    #expect(StubEnvironmentProtocol.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil })

    StubEnvironmentProtocol.requests = []
    StubEnvironmentProtocol.descriptorEnvironmentId = "env-1"
    let response = try await client.dispatchCommand(environmentId: "env-1", payload: ["type": .string("thread.pin")])
    #expect(response.sequence == 7)
    #expect(StubEnvironmentProtocol.requests.last?.value(forHTTPHeaderField: "Authorization") == "Bearer secret-token")
  }

  @Test("Signs valid RFC 9449 ES256 DPoP proof JWT")
  func signsValidDpopProof() throws {
    let key = P256.Signing.PrivateKey()
    let rawKey = (key.rawRepresentation + key.publicKey.x963Representation).base64EncodedString()
    let client = T3ServerClient(credentials: InMemoryCredentials())
    let url = URL(string: "https://example.t3.codes/api/orchestration/commands?foo=bar")!
    let jwt = try client.buildDpopProof(
      method: "POST",
      url: url,
      accessToken: "test-access-token",
      privateKeyBase64: rawKey
    )
    let parts = try #require(jwt).split(separator: ".")
    #expect(parts.count == 3)
  }

  @Test("Resolves Spotlight identifier back to deep link URL")
  func resolvesSpotlightDeepLink() throws {
    let store = makeTempStore()
    let runtime = T3IntentsRuntime(store: store, credentials: InMemoryCredentials())
    let thread = T3ThreadRecord(
      id: "env-1:thread-abc",
      environmentId: "env-1",
      threadId: "thread-abc",
      projectId: "proj-1",
      projectName: "t3code",
      title: "Check CI",
      branch: nil,
      status: "running",
      hasPendingRequest: false,
      pendingRequestSummary: nil,
      isPinned: false,
      isSettled: false,
      isSnoozed: false,
      snoozedUntil: nil,
      lastMessagePreview: nil,
      providerLabel: nil,
      modelLabel: nil,
      updatedAt: "2026-09-10T12:00:00.000Z",
      deepLinkUrl: "t3code://threads/env-1/thread-abc"
    )
    try store.upsertThreadRecord(thread)
    let resolved = runtime.resolveDeepLink(forSpotlightIdentifier: "env-1:thread-abc")
    #expect(resolved?.absoluteString == "t3code://threads/env-1/thread-abc")
  }
}
