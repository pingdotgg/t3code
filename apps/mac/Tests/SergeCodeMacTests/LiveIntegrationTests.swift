import Foundation
import Testing

@testable import SergeCodeMac

private enum RemoteLiveTestError: Error {
    case streamEnded
    case timedOut
}

private final class InMemoryKeychainStore: KeychainStoreProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    func readToken(deviceID: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[deviceID]
    }

    func writeToken(_ token: String, deviceID: String, label: String) throws {
        _ = label
        lock.lock()
        values[deviceID] = token
        lock.unlock()
    }

    func deleteToken(deviceID: String) throws {
        lock.lock()
        values[deviceID] = nil
        lock.unlock()
    }
}

private func waitForReady(
    _ events: AsyncStream<BackendEvent>,
    timeout: Duration = .seconds(90)
) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask {
            for await event in events {
                if case .connection(.ready) = event {
                    return
                }
            }
            throw RemoteLiveTestError.streamEnded
        }
        group.addTask {
            try await Task.sleep(for: timeout)
            throw RemoteLiveTestError.timedOut
        }
        defer { group.cancelAll() }
        _ = try await group.next()
    }
}

private func waitForProject(
    _ backend: LiveBackend,
    id: String,
    attempts: Int = 100
) async throws -> [Project] {
    for _ in 0..<attempts {
        let projects = try await backend.projects()
        if projects.contains(where: { $0.id == id }) {
            return projects
        }
        try await Task.sleep(for: .milliseconds(100))
    }
    throw RemoteLiveTestError.timedOut
}

@Suite("LiveIntegrationTests")
@MainActor
struct LiveIntegrationTests {
    @Test(
        "pairs a local sidecar back into a remote LiveBackend",
        .enabled(if: ProcessInfo.processInfo.environment["SERGECODE_LIVE_E2E"] == "1")
    )
    func remotePairingRoundTrip() async throws {
        let scratchRoot =
            NSTemporaryDirectory() + "sergecode-remote-pairing-\(UUID().uuidString)"
        let projectPath = scratchRoot + "/project"
        let defaultsSuite = "sergecode-remote-pairing-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsSuite))
        let deviceStore = await RemoteDeviceStore(defaults: defaults)
        let keychain = InMemoryKeychainStore()
        let fileManager = FileManager.default

        try fileManager.createDirectory(atPath: projectPath, withIntermediateDirectories: true)
        defer {
            defaults.removePersistentDomain(forName: defaultsSuite)
            try? fileManager.removeItem(atPath: scratchRoot)
        }

        let local = LiveBackend(
            allowLanAccess: true,
            baseDirectory: scratchRoot + "/local-home")
        let localEvents = await local.events()
        var remote: LiveBackend?

        do {
            // This is the same local-sidecar path used by the app. The LAN
            // bind is enabled so the normal pairing mint endpoint is active;
            // the URL is rewritten to loopback below for this single-process
            // test.
            await local.start()
            try await waitForReady(localEvents)

            let minted = try await local.mintMobilePairing(label: "Mac")
            var pairingComponents = try #require(
                URLComponents(url: minted.pairingURL, resolvingAgainstBaseURL: false))
            pairingComponents.host = "127.0.0.1"
            let pairingURL = try #require(pairingComponents.url?.absoluteString)

            let device = try await RemotePairing.pair(
                pairingURL: pairingURL,
                deviceStore: deviceStore,
                keychain: keychain)
            #expect(device.host == "127.0.0.1")
            let storedDeviceIDs = (await deviceStore.all()).map(\.id)
            #expect(storedDeviceIDs == [device.id])
            #expect(try keychain.readToken(deviceID: device.id) != nil)

            remote = LiveBackend(
                mode: .remote(device: device, keychain: keychain))
            let remoteBackend = try #require(remote)
            let remoteEvents = await remoteBackend.events()
            await remoteBackend.start()
            try await waitForReady(remoteEvents)

            let localProject = try await local.addProject(path: projectPath)
            let remoteProjects = try await waitForProject(remoteBackend, id: localProject.id)
            let remoteThreads = try await remoteBackend.threads()
            #expect(remoteProjects.contains { $0.id == localProject.id })
            #expect(remoteThreads.isEmpty)

            await remoteBackend.stop()
            await local.stop()
        } catch {
            await remote?.stop()
            await local.stop()
            throw error
        }
    }
}
