import AVFoundation
import Foundation
import Testing
@testable import T3Code

@Suite("Voice recording writer")
struct AppleVoiceRecordingWriterTests {
    @Test
    func convertsMicrophoneAudioToTheAnalyzerFormatAndStopsAtTheLimit() throws {
        guard #available(iOS 26.0, *) else { return }
        // Device microphones usually deliver 48 kHz Float32. The analyzer asks for less.
        let input = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let analyzer = try #require(AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true
        ))
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-voice-writer-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: url) }

        let writer = try AppleVoiceRecordingWriter(
            url: url, fileFormat: analyzer, maximumDuration: 0.5
        )
        // About one second of a 440 Hz tone in tap-sized buffers.
        for chunk in 0..<12 {
            writer.append(try tone(format: input, frames: 4096, startFrame: chunk * 4096))
        }
        writer.finish()

        let file = try AVAudioFile(forReading: url)
        #expect(file.fileFormat.sampleRate == 16_000)
        #expect(file.fileFormat.commonFormat == .pcmFormatInt16)
        #expect(file.fileFormat.channelCount == 1)
        #expect(file.length == 8_000)

        let samples = try #require(AVAudioPCMBuffer(
            pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)
        ))
        try file.read(into: samples)
        let channel = try #require(samples.floatChannelData?[0])
        let peak = (0..<Int(samples.frameLength)).reduce(Float(0)) { max($0, abs(channel[$1])) }
        #expect(peak > 0.5)
    }

    private func tone(
        format: AVAudioFormat,
        frames: Int,
        startFrame: Int
    ) throws -> AVAudioPCMBuffer {
        let buffer = try #require(AVAudioPCMBuffer(
            pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)
        ))
        buffer.frameLength = AVAudioFrameCount(frames)
        let channel = try #require(buffer.floatChannelData?[0])
        for frame in 0..<frames {
            let time = Double(startFrame + frame) / format.sampleRate
            channel[frame] = Float(0.8 * sin(2 * .pi * 440 * time))
        }
        return buffer
    }
}
