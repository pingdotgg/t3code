import AudioToolbox
import Foundation

enum VoiceRecordingPCM {
  static func signed16(file: URL) throws -> Data {
    var pcm = Data()
    try read(file: file, zero: Int16(0), flags: kAudioFormatFlagIsSignedInteger) {
      pcm.append(contentsOf: UnsafeRawBufferPointer($0))
    }
    return pcm
  }

  static func float32(file: URL, checkCancellation: () throws -> Void) throws -> [Float] {
    var pcm: [Float] = []
    try read(file: file, zero: Float(0), flags: kAudioFormatFlagIsFloat) {
      try checkCancellation()
      pcm.append(contentsOf: $0)
    }
    return pcm
  }

  private static func read<Sample>(
    file uri: URL,
    zero: Sample,
    flags: AudioFormatFlags,
    consume: (UnsafeBufferPointer<Sample>) throws -> Void
  ) throws {
    guard uri.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
    var opened: ExtAudioFileRef?
    try check(ExtAudioFileOpenURL(uri as CFURL, &opened))
    guard let file = opened else { throw CocoaError(.fileReadCorruptFile) }
    defer { ExtAudioFileDispose(file) }

    let sampleRate = 16_000
    let bytesPerSample = UInt32(MemoryLayout<Sample>.stride)
    var format = AudioStreamBasicDescription(
      mSampleRate: Double(sampleRate), mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: flags | kAudioFormatFlagIsPacked,
      mBytesPerPacket: bytesPerSample, mFramesPerPacket: 1, mBytesPerFrame: bytesPerSample,
      mChannelsPerFrame: 1, mBitsPerChannel: bytesPerSample * 8, mReserved: 0)
    let formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try check(
      ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat, formatSize, &format))

    var chunk = [Sample](repeating: zero, count: 8192)
    var frameCount = 0
    try chunk.withUnsafeMutableBufferPointer { samples in
      while true {
        var frames = UInt32(samples.count)
        var buffers = AudioBufferList(
          mNumberBuffers: 1,
          mBuffers: AudioBuffer(
            mNumberChannels: 1, mDataByteSize: frames * bytesPerSample, mData: samples.baseAddress))
        try check(ExtAudioFileRead(file, &frames, &buffers))
        if frames == 0 { break }
        frameCount += Int(frames)
        guard frameCount <= sampleRate * 301 else { throw CocoaError(.fileReadTooLarge) }
        try consume(UnsafeBufferPointer(start: samples.baseAddress, count: Int(frames)))
      }
    }
    guard frameCount > 0 else { throw CocoaError(.fileReadCorruptFile) }
  }

  private static func check(_ status: OSStatus) throws {
    guard status == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
  }
}
