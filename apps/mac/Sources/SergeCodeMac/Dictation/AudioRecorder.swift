import AVFoundation

/// Captures microphone audio via AVAudioEngine, mixing down to mono Float32
/// at the input node's native sample rate. Resampling to the 16 kHz the ASR
/// model expects happens once at transcription time via FluidAudio's own
/// converter — a single pass over the finished utterance avoids the edge
/// artifacts of converting tap buffers independently.
final class AudioRecorder: @unchecked Sendable {
    enum RecorderError: Error {
        case noInputAvailable
    }

    private let engine = AVAudioEngine()
    // Guards `samples`/`sampleRate`: the tap block appends from a realtime
    // audio thread while start/stop run on the caller's executor.
    private let lock = NSLock()
    private var samples: [Float] = []
    private var sampleRate: Double = 0

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
        for channel in 0..<channelCount {
            let data = channels[channel]
            for frame in 0..<frames {
                mono[frame] += data[frame]
            }
        }
        if channelCount > 1 {
            let scale = 1 / Float(channelCount)
            for frame in 0..<frames {
                mono[frame] *= scale
            }
        }
        lock.withLock { samples.append(contentsOf: mono) }
    }
}
