import Foundation
import Observation

enum FeatureMicrophoneKind: String, CaseIterable, Codable {
    case wired, bluetooth, builtIn, carPlay

    init?(portType: String) {
        switch portType {
        case "MicrophoneWired", "USBAudio", "LineIn": self = .wired
        case "BluetoothHFP", "BluetoothLE": self = .bluetooth
        case "MicrophoneBuiltIn": self = .builtIn
        case "CarAudio": self = .carPlay
        default: return nil
        }
    }

    var remembersDevices: Bool { self == .wired || self == .bluetooth }
}

struct FeatureMicrophoneInput: Equatable {
    let uid: String
    let name: String
    let portType: String
}

enum FeatureMicrophoneEntry: Codable, Equatable, Identifiable {
    case kind(FeatureMicrophoneKind)
    case device(FeatureMicrophoneKind, uid: String, name: String)

    var microphoneKind: FeatureMicrophoneKind {
        switch self {
        case .kind(let kind), .device(let kind, _, _): kind
        }
    }

    var deviceUID: String? {
        if case .device(_, let uid, _) = self { return uid }
        return nil
    }

    var deviceName: String? {
        if case .device(_, _, let name) = self { return name }
        return nil
    }

    var id: String { deviceUID ?? "kind:\(microphoneKind.rawValue)" }
}

enum FeatureMicrophonePriority {
    static func order(_ saved: [FeatureMicrophoneEntry] = []) -> [FeatureMicrophoneEntry] {
        var entries: [FeatureMicrophoneEntry] = []
        var keys = Set<String>()
        for entry in saved {
            let row = entry.microphoneKind.remembersDevices ? entry : .kind(entry.microphoneKind)
            if keys.insert(row.id).inserted { entries.append(row) }
        }
        let kinds = FeatureMicrophoneKind.allCases
        for (rank, kind) in kinds.enumerated() where !keys.contains("kind:\(kind.rawValue)") {
            let lastDevice = entries.lastIndex { $0.microphoneKind == kind }
            let below = entries.firstIndex {
                $0.deviceUID == nil && kinds.dropFirst(rank + 1).contains($0.microphoneKind)
            }
            entries.insert(.kind(kind), at: lastDevice.map { $0 + 1 } ?? below ?? entries.count)
        }
        return entries
    }

    static func remembering(
        _ inputs: [FeatureMicrophoneInput], in order: [FeatureMicrophoneEntry]
    ) -> [FeatureMicrophoneEntry] {
        var entries = order
        for input in inputs {
            guard let kind = FeatureMicrophoneKind(portType: input.portType),
                  kind.remembersDevices else { continue }
            let device = FeatureMicrophoneEntry.device(kind, uid: input.uid, name: input.name)
            if let index = entries.firstIndex(where: { $0.id == input.uid }) {
                entries[index] = device
            } else {
                let fallback = entries.firstIndex { $0 == .kind(kind) } ?? entries.count
                entries.insert(device, at: fallback)
            }
        }
        return entries
    }

    static func preferredInput(
        _ inputs: [FeatureMicrophoneInput], order: [FeatureMicrophoneEntry]
    ) -> FeatureMicrophoneInput? {
        let listed = Set(order.compactMap(\.deviceUID))
        for entry in order {
            let input = inputs.first { candidate in
                if let uid = entry.deviceUID { return candidate.uid == uid }
                return FeatureMicrophoneKind(portType: candidate.portType) == entry.microphoneKind
                    && !listed.contains(candidate.uid)
            }
            if let input { return input }
        }
        return nil
    }
}

// Microphone hardware and its order belong to this device, across all environments.
@MainActor
@Observable
final class FeatureMicrophonePreferences {
    static let shared = FeatureMicrophonePreferences()
    private static let key = "t3.microphonePriority"
    private let defaults: UserDefaults
    private(set) var entries: [FeatureMicrophoneEntry]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let saved = defaults.data(forKey: Self.key).flatMap {
            try? JSONDecoder().decode([FeatureMicrophoneEntry].self, from: $0)
        }
        entries = FeatureMicrophonePriority.order(saved ?? [])
    }

    func update(_ order: [FeatureMicrophoneEntry]) {
        let next = FeatureMicrophonePriority.order(order)
        guard next != entries, let data = try? JSONEncoder().encode(next) else { return }
        defaults.set(data, forKey: Self.key)
        entries = next
    }

    func remember(_ inputs: [FeatureMicrophoneInput]) {
        update(FeatureMicrophonePriority.remembering(inputs, in: entries))
    }
}
