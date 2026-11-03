import ExpoModulesCore

public final class T3HighlightsModule: Module {
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("T3Highlights")

    Function("tokenize") { (source: String, language: Int) -> ArrayBuffer? in
      var source = source
      return source.withUTF8 { utf8 in
        self.lock.withLock { Self.tokenize(utf8, language: language) }
      }
    }
  }

  private static func tokenize(_ utf8: UnsafeBufferPointer<UInt8>, language: Int) -> ArrayBuffer? {
    guard let languageId = UInt8(exactly: language) else { return nil }
    var records: UnsafePointer<UInt32>?
    let count = t3_highlights_tokenize(utf8.baseAddress, utf8.count, languageId, &records)
    guard count >= 0 else { return nil }
    let byteCount = Int(count) * MemoryLayout<UInt32>.size
    let buffer = ArrayBuffer(size: byteCount, initializeToZero: false)
    if let records, byteCount > 0 {
      buffer.withUnsafeMutableBytes { $0.copyMemory(from: UnsafeRawBufferPointer(start: records, count: byteCount)) }
    }
    return buffer
  }
}
