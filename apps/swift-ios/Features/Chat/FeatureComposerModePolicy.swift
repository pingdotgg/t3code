import Foundation

public enum FeatureFollowUpBehavior: String, CaseIterable, Sendable, Codable {
    case queue, steer

    public var label: String { self == .queue ? "Queue" : "Steer" }
}

/// Capture this delivery when Send is tapped so retries keep the same intent.
struct FeatureComposerSendPresentation: Equatable {
    let delivery: FeatureMessageDelivery
    let label: String
    let symbol: String
    var alternateDelivery: FeatureMessageDelivery? = nil
    var alternateLabel: String? = nil

    static func resolve(
        isWorking: Bool,
        canSteer: Bool,
        followUpBehavior: FeatureFollowUpBehavior,
        supportsExplicitDelivery: Bool = true
    ) -> Self {
        guard isWorking else { return Self(delivery: .auto, label: "Send", symbol: "arrow.up") }
        guard supportsExplicitDelivery else {
            return Self(delivery: .auto, label: "Queue", symbol: "list.number")
        }
        if canSteer, followUpBehavior == .steer {
            // Auto can start a new turn if the live turn finishes before delivery.
            return Self(delivery: .auto, label: "Steer", symbol: "arrow.turn.left.up",
                        alternateDelivery: .queue, alternateLabel: "Queue")
        }
        return Self(delivery: .queue, label: "Queue", symbol: "list.number",
                    alternateDelivery: canSteer ? .auto : nil, alternateLabel: canSteer ? "Steer" : nil)
    }
}

enum FeatureComposerModePolicy {
    static func runtimeModes(
        for selection: FeatureSelection?, providers: [FeatureProvider]
    ) -> [FeatureRuntimeMode] {
        let supported = providers.first { $0.id == selection?.providerID }?
            .models.first { $0.id == selection?.modelID }?.supportedRuntimeModes
        guard let supported, !supported.isEmpty else { return FeatureRuntimeMode.allCases }
        return FeatureRuntimeMode.allCases.filter(supported.contains)
    }

    static func compatibleRuntimeMode(
        _ mode: FeatureRuntimeMode, choices: [FeatureRuntimeMode]
    ) -> FeatureRuntimeMode {
        choices.contains(mode) ? mode : choices.first ?? mode
    }

    static func interactionMode(
        _ mode: FeatureInteractionMode, provider: FeatureProvider?
    ) -> FeatureInteractionMode {
        provider?.showInteractionModeToggle == false ? .standard : mode
    }
}

enum FeatureComposerAttachmentEligibility {
    static func validationMessage(
        attachments: [FeatureDraftAttachment], imagesAllowed: Bool, maximumFileBytes: Int?
    ) -> String? {
        if attachments.contains(where: { $0.mimeType.hasPrefix("image/") }), !imagesAllowed {
            return "This model does not support images."
        }
        let files = attachments.filter { !$0.mimeType.hasPrefix("image/") }
        guard !files.isEmpty else { return nil }
        guard let maximumFileBytes else { return "This environment does not accept file attachments." }
        if files.contains(where: { $0.byteCount > maximumFileBytes }) {
            return "A file exceeds the attachment size limit for this environment."
        }
        return nil
    }
}

/// Reads only V2 control records, so handoff does not require copying the transcript.
enum FeatureProviderHandoffPolicy {
    static func allowsProviderSwitch(projection: JSONValue?) -> Bool {
        guard let projection, let thread = projection["thread"] else { return false }
        let runs = projection["runs"]?.v2Array ?? []
        let providerThreads = projection["providerThreads"]?.v2Array ?? []
        let sessions = projection["providerSessions"]?.v2Array ?? []
        let activeRun = runs.last {
            ["preparing", "starting", "running", "waiting"].contains($0["status"]?.stringValue ?? "")
        }
        let providerThreadID = activeRun?["providerThreadId"]?.stringValue
            ?? thread["activeProviderThreadId"]?.stringValue
        let attachedThread = providerThreads.first {
            providerThreadID != nil && $0["id"]?.stringValue == providerThreadID
        } ?? providerThreads.first {
            $0["appThreadId"]?.stringValue == thread["id"]?.stringValue
                && $0["providerSessionId"]?.stringValue != nil
        }
        let session: JSONValue?
        if let sessionID = attachedThread?["providerSessionId"]?.stringValue {
            session = sessions.first { $0["id"]?.stringValue == sessionID }
        } else {
            session = sessions.last { !["stopped", "error"].contains($0["status"]?.stringValue ?? "") }
        }
        if let session {
            return session["capabilities"]?["sessions"]?["supportsProviderSwitchingViaHandoff"]?.boolValue == true
        }
        guard activeRun == nil else { return false }
        if thread["historyOrigin"]?.stringValue == "v1_import" || runs.isEmpty { return true }
        return providerThreads.contains {
            $0["id"]?.stringValue == thread["activeProviderThreadId"]?.stringValue
                && $0["appThreadId"]?.stringValue == thread["id"]?.stringValue
                && $0["providerInstanceId"]?.stringValue == thread["modelSelection"]?["instanceId"]?.stringValue
                && $0["nativeThreadRef"] != nil && $0["nativeThreadRef"] != .null
        }
    }
}
