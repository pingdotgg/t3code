import Foundation
import Observation

enum FeatureVoiceInputPhase: Equatable {
    case idle
    case preparing
    case recording
    case transcribing
    case error
}

enum FeatureVoiceInputErrorAction: Equatable {
    case retry
    case settings
}

struct FeatureVoiceDraftSnapshot: Equatable {
    let ownerID: String
    let text: String
    let revision: UInt64
    let selection: NSRange
}

struct FeatureVoiceTranscriptCommit: Equatable, Identifiable {
    let id = UUID()
    let text: String
    let caretLocation: Int
}

enum FeatureVoiceTranscriptCommitResult: Equatable {
    case commit(FeatureVoiceTranscriptCommit)
    case empty
    case stale
}

enum FeatureVoiceTranscriptResolver {
    static func resolve(
        captured: FeatureVoiceDraftSnapshot,
        current: FeatureVoiceDraftSnapshot?,
        transcript: String,
        localeIdentifier: String
    ) -> FeatureVoiceTranscriptCommitResult {
        guard let current,
              current.ownerID == captured.ownerID,
              current.text == captured.text,
              current.revision == captured.revision,
              captured.selection.location >= 0,
              captured.selection.length >= 0,
              captured.selection.location <= captured.text.utf16.count,
              captured.selection.length <= captured.text.utf16.count
                - captured.selection.location,
              Range(captured.selection, in: captured.text) != nil else {
            return .stale
        }

        let replacement = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !replacement.isEmpty else { return .empty }

        var insertion = replacement
        let normalizedLocale = localeIdentifier
            .replacingOccurrences(of: "_", with: "-")
            .lowercased()
        if captured.selection.length == 0,
           normalizedLocale == "en" || normalizedLocale.hasPrefix("en-") {
            let text = captured.text as NSString
            let location = captured.selection.location
            let left = location > 0 ? text.character(at: location - 1) : nil
            let right = location < text.length ? text.character(at: location) : nil
            let leftNeedsSpace = left.map(Self.leftBoundaryCharacters.contains) == true
                && (right == nil || right.map(Self.isWhitespace) == true)
            let rightNeedsSpace = right.map(Self.rightBoundaryCharacters.contains) == true
                && (left == nil || left.map(Self.isWhitespace) == true)
            insertion = "\(leftNeedsSpace ? " " : "")\(replacement)\(rightNeedsSpace ? " " : "")"
        }

        let nextText = (captured.text as NSString).replacingCharacters(
            in: captured.selection,
            with: insertion
        )
        return .commit(FeatureVoiceTranscriptCommit(
            text: nextText,
            caretLocation: captured.selection.location + insertion.utf16.count
        ))
    }

    private static let leftBoundaryCharacters = Set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!?,:;)]}'\""
            .utf16
    )
    private static let rightBoundaryCharacters = Set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789([{'\""
            .utf16
    )

    private static func isWhitespace(_ codeUnit: unichar) -> Bool {
        guard let scalar = UnicodeScalar(codeUnit) else { return false }
        return CharacterSet.whitespacesAndNewlines.contains(scalar)
    }
}

enum FeatureVoiceMicrophonePermission: Equatable {
    case granted
    case denied
}

@MainActor
protocol FeatureVoiceInputAdapter: AnyObject {
    var isSupported: Bool { get }
    var localeIdentifier: String { get }

    func prepare() async throws
    func requestMicrophonePermission() async -> FeatureVoiceMicrophonePermission
    func startRecording(maximumDuration: TimeInterval) throws
    func stopRecording() async throws -> URL
    func transcribe(recordingURL: URL) async throws -> String
    func cancelTranscription() async
    func cleanup() async
}

@MainActor
private enum FeatureVoiceInputOperationGate {
    static var owner: UUID?

    static func acquire(_ candidate: UUID) -> Bool {
        guard owner == nil else { return false }
        owner = candidate
        return true
    }

    static func release(_ candidate: UUID) {
        if owner == candidate { owner = nil }
    }
}

@MainActor
@Observable
final class FeatureVoiceInputController {
    static let maximumRecordingDuration: TimeInterval = 5 * 60

    private(set) var phase: FeatureVoiceInputPhase = .idle
    private(set) var errorMessage: String?
    private(set) var errorAction: FeatureVoiceInputErrorAction?
    private(set) var recordingStartedAt: Date?
    private(set) var pendingCommit: FeatureVoiceTranscriptCommit?

    @ObservationIgnored private let adapter: any FeatureVoiceInputAdapter
    @ObservationIgnored private var currentDraft: FeatureVoiceDraftSnapshot?
    @ObservationIgnored private var capturedDraft: FeatureVoiceDraftSnapshot?
    @ObservationIgnored private var operationID: UUID?
    @ObservationIgnored private var operationTask: Task<Void, Never>?
    @ObservationIgnored private var recordingLimitTask: Task<Void, Never>?

    init(adapter: any FeatureVoiceInputAdapter = FeatureVoiceInputAdapterFactory.make()) {
        self.adapter = adapter
    }

    var isSupported: Bool { adapter.isSupported }

    var isBusy: Bool {
        phase == .preparing || phase == .recording || phase == .transcribing
    }

    func updateDraft(_ snapshot: FeatureVoiceDraftSnapshot) {
        currentDraft = snapshot
    }

    func updateSelection(_ selection: NSRange) {
        guard let currentDraft else { return }
        self.currentDraft = FeatureVoiceDraftSnapshot(
            ownerID: currentDraft.ownerID,
            text: currentDraft.text,
            revision: currentDraft.revision,
            selection: selection
        )
    }

    func start() {
        guard phase == .idle || phase == .error else { return }
        guard adapter.isSupported else {
            setError("Voice transcription requires a supported device with iOS 26 or later.", nil)
            return
        }
        guard let currentDraft else {
            setError("This draft is no longer available.", .retry)
            return
        }

        let id = UUID()
        guard FeatureVoiceInputOperationGate.acquire(id) else {
            setError("Another voice recording is still finishing.", .retry)
            return
        }

        operationID = id
        capturedDraft = currentDraft
        pendingCommit = nil
        setPhase(.preparing)
        operationTask = Task { [weak self] in
            await self?.prepareAndStartRecording(id: id)
        }
    }

    func stop() {
        guard phase == .recording, let id = operationID else { return }
        recordingLimitTask?.cancel()
        recordingLimitTask = nil
        recordingStartedAt = nil
        setPhase(.transcribing)
        operationTask = Task { [weak self] in
            await self?.stopAndTranscribe(id: id)
        }
    }

    func cancel() {
        switch phase {
        case .idle:
            return
        case .error:
            clearError()
        case .preparing:
            invalidateOperation()
            setPhase(.idle)
        case .recording:
            guard let id = operationID else {
                setPhase(.idle)
                return
            }
            invalidateOperation()
            setPhase(.idle)
            operationTask = Task { [weak self] in
                await self?.cleanupAndRelease(id: id)
            }
        case .transcribing:
            invalidateOperation()
            setPhase(.idle)
            Task { [weak self] in
                await self?.adapter.cancelTranscription()
            }
        }
    }

    func ownerChanged(to snapshot: FeatureVoiceDraftSnapshot) {
        if currentDraft?.ownerID != snapshot.ownerID {
            pendingCommit = nil
            if phase != .idle { cancel() }
        }
        currentDraft = snapshot
    }

    func appMovedToBackground() {
        if isBusy { cancel() }
    }

    func recordingWasInterrupted() {
        guard phase == .recording, let id = operationID else { return }
        invalidateOperation()
        setError("Voice recording was interrupted.", .retry)
        operationTask = Task { [weak self] in
            await self?.cleanupAndRelease(id: id)
        }
    }

    func consumePendingCommit() {
        pendingCommit = nil
    }

    func waitForCurrentOperation() async {
        await operationTask?.value
    }

    private func prepareAndStartRecording(id: UUID) async {
        do {
            // Locale resolution and asset installation happen before the app
            // asks for microphone access. A permission prompt must not hide a
            // long asset download.
            try await adapter.prepare()
            guard isCurrent(id) else {
                await cleanupAndRelease(id: id)
                return
            }

            guard await adapter.requestMicrophonePermission() == .granted else {
                await cleanupAndRelease(id: id)
                if operationID == id {
                    setError("Microphone access is required for voice input.", .settings)
                    operationID = nil
                }
                return
            }
            guard isCurrent(id), draftContentMatches(capturedDraft, currentDraft) else {
                await cleanupAndRelease(id: id)
                if operationID == id {
                    setError("This draft is no longer available.", .retry)
                    operationID = nil
                }
                return
            }

            try adapter.startRecording(maximumDuration: Self.maximumRecordingDuration)
            guard isCurrent(id) else {
                await cleanupAndRelease(id: id)
                return
            }
            recordingStartedAt = .now
            setPhase(.recording)
            scheduleRecordingLimit(for: id)
        } catch {
            await cleanupAndRelease(id: id)
            if operationID == id {
                operationID = nil
                setError("Could not prepare voice input.", .retry)
            }
        }
    }

    private func stopAndTranscribe(id: UUID) async {
        do {
            let recordingURL = try await adapter.stopRecording()
            guard isCurrent(id), let capturedDraft else {
                await cleanupAndRelease(id: id)
                return
            }

            let transcript = try await adapter.transcribe(recordingURL: recordingURL)
            guard isCurrent(id) else {
                await cleanupAndRelease(id: id)
                return
            }

            let result = FeatureVoiceTranscriptResolver.resolve(
                captured: capturedDraft,
                current: currentDraft,
                transcript: transcript,
                localeIdentifier: adapter.localeIdentifier
            )
            await cleanupAndRelease(id: id)
            guard operationID == id else { return }
            operationID = nil
            self.capturedDraft = nil
            switch result {
            case let .commit(commit):
                pendingCommit = commit
                setPhase(.idle)
            case .empty:
                setError("No speech was detected.", .retry)
            case .stale:
                setError(
                    "The draft changed while voice input was running. The transcript was not added.",
                    .retry
                )
            }
        } catch {
            await cleanupAndRelease(id: id)
            if operationID == id {
                operationID = nil
                setError("Could not transcribe this recording.", .retry)
            }
        }
    }

    private func scheduleRecordingLimit(for id: UUID) {
        recordingLimitTask?.cancel()
        recordingLimitTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.maximumRecordingDuration))
            guard !Task.isCancelled, let self, self.isCurrent(id) else { return }
            self.stop()
        }
    }

    private func invalidateOperation() {
        operationID = nil
        capturedDraft = nil
        recordingStartedAt = nil
        recordingLimitTask?.cancel()
        recordingLimitTask = nil
    }

    private func cleanupAndRelease(id: UUID) async {
        await adapter.cleanup()
        FeatureVoiceInputOperationGate.release(id)
    }

    private func isCurrent(_ id: UUID) -> Bool {
        operationID == id
    }

    private func draftContentMatches(
        _ captured: FeatureVoiceDraftSnapshot?,
        _ current: FeatureVoiceDraftSnapshot?
    ) -> Bool {
        guard let captured, let current else { return false }
        return captured.ownerID == current.ownerID
            && captured.text == current.text
            && captured.revision == current.revision
    }

    private func setPhase(_ phase: FeatureVoiceInputPhase) {
        self.phase = phase
        if phase != .error {
            errorMessage = nil
            errorAction = nil
        }
    }

    private func setError(_ message: String, _ action: FeatureVoiceInputErrorAction?) {
        phase = .error
        errorMessage = message
        errorAction = action
        recordingStartedAt = nil
    }

    private func clearError() {
        errorMessage = nil
        errorAction = nil
        setPhase(.idle)
    }
}
