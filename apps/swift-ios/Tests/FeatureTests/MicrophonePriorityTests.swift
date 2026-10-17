import Foundation
import Testing
@testable import T3Code

@Suite("Microphone priority")
struct MicrophonePriorityTests {
    private let phone = FeatureMicrophoneInput(
        uid: "phone", name: "iPhone Microphone", portType: "MicrophoneBuiltIn"
    )
    private let airPods = FeatureMicrophoneInput(
        uid: "airpods", name: "AirPods Pro", portType: "BluetoothHFP"
    )
    private let bose = FeatureMicrophoneInput(
        uid: "bose", name: "Bose QC", portType: "BluetoothHFP"
    )
    private let civic = FeatureMicrophoneInput(
        uid: "civic", name: "Honda Civic", portType: "BluetoothHFP"
    )
    private let carPlay = FeatureMicrophoneInput(
        uid: "carplay", name: "CarPlay", portType: "CarAudio"
    )
    private let usb = FeatureMicrophoneInput(
        uid: "usb", name: "Shure MV7", portType: "USBAudio"
    )

    @Test
    func defaultsPreferWiredThenBluetoothThenBuiltInThenCarPlay() {
        let order = FeatureMicrophonePriority.order()
        #expect(order.map(\.id) == [
            "kind:wired", "kind:bluetooth", "kind:builtIn", "kind:carPlay",
        ])
        #expect(FeatureMicrophonePriority.preferredInput([carPlay, phone], order: order) == phone)
        #expect(FeatureMicrophonePriority.preferredInput([phone, airPods, usb], order: order) == usb)
    }

    @Test
    func fillsMissingKindsAfterTheirDevicesAndRemovesDuplicateRows() {
        let order = FeatureMicrophonePriority.order([
            .kind(.builtIn),
            .device(.bluetooth, uid: airPods.uid, name: airPods.name),
            .kind(.builtIn),
            .device(.bluetooth, uid: airPods.uid, name: "Duplicate"),
        ])
        #expect(order.map(\.id) == [
            "kind:wired", "kind:builtIn", "airpods", "kind:bluetooth", "kind:carPlay",
        ])
        #expect(FeatureMicrophonePriority.order(order) == order)
    }

    @Test
    func remembersOnlyWiredAndBluetoothAndRefreshesNamesInPlace() {
        let order = FeatureMicrophonePriority.remembering(
            [phone, carPlay, airPods, usb], in: FeatureMicrophonePriority.order()
        )
        #expect(order.map(\.id) == [
            "usb", "kind:wired", "airpods", "kind:bluetooth", "kind:builtIn", "kind:carPlay",
        ])
        #expect(FeatureMicrophonePriority.remembering([airPods, phone], in: order) == order)
        let renamed = FeatureMicrophoneInput(
            uid: airPods.uid, name: "AirPods Max", portType: airPods.portType
        )
        let updated = FeatureMicrophonePriority.remembering([renamed], in: order)
        #expect(updated.map(\.id) == order.map(\.id))
        #expect(updated.first { $0.id == airPods.uid }?.deviceName == "AirPods Max")
        #expect(FeatureMicrophonePriority.remembering([], in: updated) == updated)
    }

    @Test
    func ranksKnownDevicesSeparatelyFromTheirKindFallback() {
        let order: [FeatureMicrophoneEntry] = [
            .kind(.builtIn),
            .device(.bluetooth, uid: bose.uid, name: bose.name),
            .kind(.wired),
            .kind(.bluetooth),
            .device(.bluetooth, uid: airPods.uid, name: airPods.name),
            .kind(.carPlay),
        ]
        #expect(FeatureMicrophonePriority.preferredInput([airPods, civic], order: order) == civic)
        #expect(FeatureMicrophonePriority.preferredInput([airPods, bose], order: order) == bose)
        #expect(FeatureMicrophonePriority.preferredInput([airPods, usb], order: order) == usb)
        #expect(FeatureMicrophonePriority.preferredInput([airPods, carPlay], order: order) == airPods)
        #expect(FeatureMicrophonePriority.preferredInput([airPods, phone], order: order) == phone)
    }

    @Test
    func rememberingNewDevicesHonorsTheFallbackPositionAndKeepsKnownDeviceOrder() {
        let saved: [FeatureMicrophoneEntry] = [
            .kind(.bluetooth), .kind(.builtIn),
            .device(.bluetooth, uid: airPods.uid, name: airPods.name),
            .kind(.wired), .kind(.carPlay),
        ]
        let order = FeatureMicrophonePriority.remembering([airPods, civic], in: saved)
        #expect(order.map(\.id) == [
            "civic", "kind:bluetooth", "kind:builtIn", "airpods", "kind:wired", "kind:carPlay",
        ])
        #expect(FeatureMicrophonePriority.preferredInput([airPods, civic], order: order) == civic)
        #expect(FeatureMicrophonePriority.preferredInput([airPods, phone], order: order) == phone)
    }

    @Test
    func forgettingADeviceReturnsItToItsKindFallback() {
        let order: [FeatureMicrophoneEntry] = [
            .device(.bluetooth, uid: airPods.uid, name: airPods.name),
            .kind(.builtIn), .kind(.bluetooth), .kind(.wired), .kind(.carPlay),
        ]
        #expect(FeatureMicrophonePriority.preferredInput([airPods, phone], order: order) == airPods)
        let forgotten = FeatureMicrophonePriority.order(order.filter { $0.id != airPods.uid })
        #expect(FeatureMicrophonePriority.preferredInput([airPods, phone], order: forgotten) == phone)
    }

    @Test
    func normalizesBuiltInAndCarPlayDevicesToKindRows() {
        let order = FeatureMicrophonePriority.order([
            .device(.builtIn, uid: phone.uid, name: phone.name),
            .device(.carPlay, uid: carPlay.uid, name: carPlay.name),
        ])
        #expect(order.compactMap(\.deviceUID).isEmpty)
        #expect(order.filter { $0.microphoneKind == .builtIn } == [.kind(.builtIn)])
        #expect(order.filter { $0.microphoneKind == .carPlay } == [.kind(.carPlay)])
    }

    @Test
    func recognizesSupportedPortsAndLeavesUnknownInputsToIOS() {
        for port in ["MicrophoneWired", "USBAudio", "LineIn"] {
            #expect(FeatureMicrophoneKind(portType: port) == .wired)
        }
        for port in ["BluetoothHFP", "BluetoothLE"] {
            #expect(FeatureMicrophoneKind(portType: port) == .bluetooth)
        }
        let unknown = FeatureMicrophoneInput(uid: "virtual", name: "Virtual", portType: "Virtual")
        let order = FeatureMicrophonePriority.order()
        #expect(FeatureMicrophonePriority.preferredInput([unknown], order: order) == nil)
        #expect(FeatureMicrophonePriority.preferredInput([], order: order) == nil)
        #expect(FeatureMicrophonePriority.remembering([unknown], in: order) == order)
    }

    @Test
    func savedDeviceOrderRoundTrips() throws {
        let order = FeatureMicrophonePriority.remembering([airPods, usb], in: [
            .kind(.builtIn), .kind(.wired), .kind(.bluetooth), .kind(.carPlay),
        ])
        let data = try JSONEncoder().encode(order)
        let saved = try JSONDecoder().decode([FeatureMicrophoneEntry].self, from: data)
        #expect(FeatureMicrophonePriority.order(saved) == order)
    }
}
