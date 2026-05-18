import Foundation
import OSLog

public enum MobileProtocolTimingName: String, CaseIterable, Sendable {
    case appLaunchStart = "app_launch_start"
    case cachedShellLoadComplete = "cached_shell_load_complete"
    case firstShellRender = "first_shell_render"
    case webSocketConnected = "websocket_connected"
    case firstShellSnapshotReceived = "first_shell_snapshot_received"
    case firstThreadSnapshotReceived = "first_thread_snapshot_received"
    case firstLiveEventApplied = "first_live_event_applied"
    case activeTranscriptRenderComplete = "active_transcript_render_complete"
    case replayGapDetected = "replay_gap_detected"
    case resnapshotComplete = "resnapshot_complete"

    var signpostName: StaticString {
        switch self {
        case .appLaunchStart:
            "app_launch_start"
        case .cachedShellLoadComplete:
            "cached_shell_load_complete"
        case .firstShellRender:
            "first_shell_render"
        case .webSocketConnected:
            "websocket_connected"
        case .firstShellSnapshotReceived:
            "first_shell_snapshot_received"
        case .firstThreadSnapshotReceived:
            "first_thread_snapshot_received"
        case .firstLiveEventApplied:
            "first_live_event_applied"
        case .activeTranscriptRenderComplete:
            "active_transcript_render_complete"
        case .replayGapDetected:
            "replay_gap_detected"
        case .resnapshotComplete:
            "resnapshot_complete"
        }
    }
}

public struct MobileProtocolTiming: Sendable {
    private let logger: Logger
    private let signposter: OSSignposter

    public init(subsystem: String = "tools.t3.mobile", category: String = "sync") {
        logger = Logger(subsystem: subsystem, category: category)
        signposter = OSSignposter(subsystem: subsystem, category: category)
    }

    public func mark(_ name: MobileProtocolTimingName) {
        logger.debug("\(name.rawValue, privacy: .public)")
        signposter.emitEvent(name.signpostName)
    }

    public func begin(_ name: MobileProtocolTimingName) -> OSSignpostIntervalState {
        let state = signposter.beginInterval(name.signpostName)
        logger.debug("begin \(name.rawValue, privacy: .public)")
        return state
    }

    public func end(_ name: MobileProtocolTimingName, _ state: OSSignpostIntervalState) {
        signposter.endInterval(name.signpostName, state)
        logger.debug("end \(name.rawValue, privacy: .public)")
    }
}
