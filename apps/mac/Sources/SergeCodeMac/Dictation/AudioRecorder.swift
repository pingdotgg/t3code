import AVFoundation

/// Captures microphone audio via AVAudioEngine, mixing down to mono Float32
/// at the input node's native sample rate. Every tap buffer is also forwarded
/// to `onBuffer` as it arrives so the streaming transcriber can produce live
/// partials; the full utterance is kept for the final batch pass, which
/// resamples to the 16 kHz the ASR model expects in a single conversion —
/// avoiding the edge artifacts of converting tap buffers independently.
final class AudioRecorder: @unchecked Sendable {
    enum RecorderError: Error {
        case noInputAvailable
    }

    /// Called from the realtime audio thread with each captured tap buffer
    /// (native input format) and a smoothed peak level in 0...1 for UI
    /// metering. Must be cheap and non-blocking.
    var onBuffer: (@Sendable (AVAudioPCMBuffer, Float) -> Void)?

    private let engine = AVAudioEngine()
    // Guards `samples`/`sampleRate`/`smoothedLevel`: the tap block appends
    // from a realtime audio thread while start/stop run on the caller's
    // executor.
    private let lock = NSLock()
    private var samples: [Float] = []
    private var sampleRate: Double = 0
    private var smoothedLevel: Float = 0

    static func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        default:
            return await AVAudioApplication.requestRecordPermission()
        }
    }

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw RecorderError.noInputAvailable
        }
        lock.withLock {
            samples.removeAll()
            sampleRate = format.sampleRate
            smoothedLevel = 0
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
    }

    /// Stops the engine and returns the captured utterance as a mono
    /// Float32 buffer at the native input rate, or nil when nothing usable
    /// was captured.
    func stop() -> AVAudioPCMBuffer? {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        let (captured, rate) = lock.withLock { (samples, sampleRate) }
        guard !captured.isEmpty, rate > 0,
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1,
                interleaved: false),
            let buffer = AVAudioPCMBuffer(
                pcmFormat: format, frameCapacity: AVAudioFrameCount(captured.count))
        else { return nil }
        captured.withUnsafeBufferPointer { source in
            buffer.floatChannelData![0].update(
                from: source.baseAddress!, count: captured.count)
        }
        buffer.frameLength = AVAudioFrameCount(captured.count)
        return buffer
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return }
        let channelCount = Int(buffer.format.channelCount)
        var mono = [Float](repeating: 0, count: frames)
        var peak: Float = 0
        for channel in 0..<channelCount {
            let data = channels[channel]
            for frame in 0..<frames {
                let sample = data[frame]
                mono[frame] += sample
                let magnitude = abs(sample)
                if magnitude > peak { peak = magnitude }
            }
        }
        if channelCount > 1 {
            let scale = 1 / Float(channelCount)
            for frame in 0..<frames {
                mono[frame] *= scale
            }
        }
        // Peak-hold with decay so the meter feels responsive on attack but
        // doesn't strobe between tap buffers.
        let level = lock.withLock {
            smoothedLevel = max(peak, smoothedLevel * 0.72)
            samples.append(contentsOf: mono)
            return smoothedLevel
        }
        onBuffer?(buffer, level)
    }
}
