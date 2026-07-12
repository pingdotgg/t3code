import Foundation
import Testing
@testable import SergeCodeMac

@Suite("RemoteDeviceStore")
struct RemoteDeviceStoreTests {
    @Test("round-trips metadata, upserts by id, and removes idempotently")
    func roundTrip() {
        let suiteName = "remote-device-store-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = RemoteDeviceStore(defaults: defaults)
        let pairedAt = Date(timeIntervalSince1970: 1_000)
        let expiresAt = Date(timeIntervalSince1970: 2_000)
        let first = RemoteDevice(
            id: "env-a",
            name: "Studio Mac",
            host: "studio.local",
            port: 3773,
            pairedAt: pairedAt,
            sessionExpiresAt: expiresAt)
        let second = RemoteDevice(
            id: "env-b",
            name: "Build Mac",
            host: "192.168.1.20",
            port: 44342,
            pairedAt: pairedAt,
            sessionExpiresAt: nil)

        store.upsert(first)
        store.upsert(second)
        #expect(store.all() == [first, second])

        let updated = RemoteDevice(
            id: first.id,
            name: "Studio Mac Renamed",
            host: "studio-new.local",
            port: 4000,
            pairedAt: pairedAt,
            sessionExpiresAt: nil)
        store.upsert(updated)
        #expect(store.all() == [updated, second])

        store.remove(id: second.id)
        store.remove(id: second.id)
        #expect(store.all() == [updated])
    }
}
