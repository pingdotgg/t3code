import AudioToolbox
import ExpoModulesCore
import Foundation

public class T3VoiceTranscriptionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3VoiceTranscription")

    AsyncFunction("decodeRecording") { (uri: URL) throws -> Data in
      guard uri.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
      var opened: ExtAudioFileRef?
      try check(ExtAudioFileOpenURL(uri as CFURL, &opened))
      guard let file = opened else { throw CocoaError(.fileReadCorruptFile) }
      defer { ExtAudioFileDispose(file) }
      var format = AudioStreamBasicDescription(
        mSampleRate: 16_000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
        mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
      let formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
      try check(ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat, formatSize, &format))
      var pcm = Data()
      var chunk = [Int16](repeating: 0, count: 8192)
      try chunk.withUnsafeMutableBytes { bytes in
        while true {
          var frames = UInt32(bytes.count / 2)
          var buffers = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
            mNumberChannels: 1, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress))
          try check(ExtAudioFileRead(file, &frames, &buffers))
          if frames == 0 { break }
          let count = Int(frames) * 2
          guard pcm.count + count <= 16_000 * 2 * 301 else { throw CocoaError(.fileReadTooLarge) }
          pcm.append(contentsOf: bytes.prefix(count))
        }
      }
      guard !pcm.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
      return pcm
    }
  }
}

private func check(_ status: OSStatus) throws {
  guard status == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
}
