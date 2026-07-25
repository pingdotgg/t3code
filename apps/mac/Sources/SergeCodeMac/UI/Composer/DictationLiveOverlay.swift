import SwiftUI

/// Live dictation surface above the composer. While recording it shows the
/// streaming transcript as it is recognized — stable (confirmed) text in
/// primary, the still-changing volatile tail dimmed — plus a mic level meter
/// so it's obvious the machine is listening. On stop it flips to a brief
/// "Finishing…" beat (the batch pass over warm models), and while cleanup
/// polishes the already-inserted text it shows "Polishing…".
struct DictationLiveOverlay: View {
    let dictation: DictationController

    private static let barProfiles = [0.55, 0.9, 1.0, 0.7]
    private static let meterHeight = 14.0
    private static let meterFloor = 3.0

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            meter
            // DictationState is Equatable (DictationController.swift:6). Keyed
            // on state, not the transcript, so streaming words don't retrigger it.
            content
                .animation(Motion.reveal, value: dictation.state)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .glassEffect(.regular, in: .rect(cornerRadius: AlpineTheme.Corners.card))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var content: some View {
        switch dictation.state {
        case .recording:
            if dictation.liveTranscript.isEmpty {
                Text("Listening…")
                    .font(SurgeTypography.composer)
                    .foregroundStyle(.secondary)
            } else {
                transcriptText
                    .font(SurgeTypography.composer)
                    .lineLimit(2)
                    // The newest words matter; let the start of long
                    // utterances scroll out of view.
                    .truncationMode(.head)
            }
        case .processing:
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Finishing…")
                    .font(SurgeTypography.composer)
                    .foregroundStyle(.secondary)
            }
        case .idle:
            // Only reachable while the cleanup pass polishes inserted text.
            Label("Polishing…", systemImage: "sparkles")
                .font(SurgeTypography.composer)
                .foregroundStyle(.secondary)
        }
    }

    private var transcriptText: Text {
        var combined = AttributedString(dictation.confirmedTranscript)
        guard !dictation.volatileTranscript.isEmpty else { return Text(combined) }
        if !dictation.confirmedTranscript.isEmpty {
            combined += " "
        }
        var volatile = AttributedString(dictation.volatileTranscript)
        volatile.foregroundColor = .secondary
        combined += volatile
        return Text(combined)
    }

    private var meter: some View {
        // Reduce Motion swaps the level-driven bars for a static marker —
        // the recording tint still communicates the state.
        let level = Motion.reduceMotion ? 0 : dictation.audioLevel
        return HStack(spacing: 2.5) {
            ForEach(0..<Self.barProfiles.count, id: \.self) { index in
                Capsule()
                    .fill(dictation.state == .recording ? Color.red : Color.secondary)
                    .frame(width: 3, height: barHeight(for: index, level: level))
            }
        }
        .frame(height: Self.meterHeight)
        .animation(Motion.ambient, value: dictation.audioLevel)
    }

    private func barHeight(for index: Int, level: Double) -> Double {
        let scaled = min(level * 1.6, 1) * Self.barProfiles[index]
        return Self.meterFloor + (Self.meterHeight - Self.meterFloor) * scaled
    }

    private var accessibilityText: String {
        switch dictation.state {
        case .recording:
            dictation.liveTranscript.isEmpty
                ? "Dictation listening" : "Dictation: \(dictation.liveTranscript)"
        case .processing: "Finishing dictation"
        case .idle: "Polishing dictated text"
        }
    }
}
