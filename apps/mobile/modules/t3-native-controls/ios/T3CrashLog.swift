import Foundation

/// Durable crash persistence for Documents/crash-logs.
///
/// The Expo module uses this for JS `writeSyncText`. AppDelegate installs
/// `RCTSetFatalHandler` and calls `persistNativeFatal` so reportFatal still
/// leaves a last-crash.json when the JS ErrorUtils path never flushes.
public enum T3CrashLog {
  public static let directoryName = "crash-logs"
  public static let lastCrashFileName = "last-crash.json"

  private static let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  /// Shared fsync write used by the Expo module and native fatal hooks.
  @discardableResult
  public static func writeSyncText(relativePath: String, contents: String) -> Bool {
    do {
      let docs = try FileManager.default.url(
        for: .documentDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      )
      let url = docs.appendingPathComponent(relativePath)
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      let data = Data(contents.utf8)
      // Non-atomic: under abort we prefer a partial file over losing the rename.
      try data.write(to: url, options: [])
      let handle = try FileHandle(forWritingTo: url)
      defer { try? handle.close() }
      if #available(iOS 13.0, *) {
        try handle.synchronize()
      }
      return true
    } catch {
      return false
    }
  }

  /// Persist a native RCTFatal / RCTFatalException payload.
  public static func persistNativeFatal(
    message: String,
    name: String,
    stack: String?,
    extra: String?,
    source: String
  ) {
    let truncatedMessage = truncate(message, max: 8_000)
    let truncatedStack = stack.map { truncate($0, max: 48_000) }
    let capturedAt = isoFormatter.string(from: Date())
    let millis = Int(Date().timeIntervalSince1970 * 1000)

    var record: [String: Any] = [
      "breadcrumbs": [] as [Any],
      "capturedAt": capturedAt,
      "handlerInvocation": 0,
      "isFatal": true,
      "message": truncatedMessage,
      "name": name,
      "source": source,
    ]
    if let truncatedStack, !truncatedStack.isEmpty {
      record["stack"] = truncatedStack
    }
    if let extra, !extra.isEmpty {
      record["extraData"] = truncate(extra, max: 8_000)
    }

    guard let data = try? JSONSerialization.data(withJSONObject: record, options: []),
          let contents = String(data: data, encoding: .utf8)
    else {
      let escaped = truncatedMessage
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
      let fallback =
        "{\"capturedAt\":\"\(capturedAt)\",\"isFatal\":true,\"message\":\"\(escaped)\",\"name\":\"\(name)\",\"source\":\"\(source)\",\"handlerInvocation\":0,\"breadcrumbs\":[]}"
      _ = writeSyncText(relativePath: "\(directoryName)/\(lastCrashFileName)", contents: fallback)
      _ = writeSyncText(
        relativePath: "\(directoryName)/crash-native-\(millis)-0.json",
        contents: fallback
      )
      return
    }

    _ = writeSyncText(relativePath: "\(directoryName)/\(lastCrashFileName)", contents: contents)
    _ = writeSyncText(
      relativePath: "\(directoryName)/crash-native-\(millis)-0.json",
      contents: contents
    )
  }

  public static func formatJSStack(_ value: Any?) -> String? {
    guard let value else {
      return nil
    }
    if let text = value as? String {
      return text
    }
    if let frames = value as? [[String: Any]] {
      let lines = frames.prefix(80).map { frame -> String in
        let method = frame["methodName"] as? String ?? "?"
        let file = frame["file"] as? String ?? "?"
        let line = stringifyFrameNumber(frame["lineNumber"])
        let column = stringifyFrameNumber(frame["column"])
        return "    at \(method) (\(file):\(line):\(column))"
      }
      return lines.joined(separator: "\n")
    }
    return String(describing: value)
  }

  public static func formatExceptionStack(_ exception: NSException) -> String {
    let addresses = exception.callStackSymbols
    if addresses.isEmpty {
      return exception.callStackReturnAddresses.map { String(describing: $0) }.joined(separator: "\n")
    }
    return addresses.prefix(80).joined(separator: "\n")
  }

  public static func stringValue(_ value: Any?) -> String? {
    guard let value, !(value is NSNull) else {
      return nil
    }
    if let text = value as? String {
      return text
    }
    if JSONSerialization.isValidJSONObject(value),
       let data = try? JSONSerialization.data(withJSONObject: value, options: []),
       let text = String(data: data, encoding: .utf8)
    {
      return text
    }
    return String(describing: value)
  }

  private static func truncate(_ text: String, max: Int) -> String {
    guard text.count > max else {
      return text
    }
    let end = text.index(text.startIndex, offsetBy: max)
    return String(text[..<end]) + "…"
  }

  private static func stringifyFrameNumber(_ value: Any?) -> String {
    if let number = value as? NSNumber {
      return number.stringValue
    }
    if let intValue = value as? Int {
      return String(intValue)
    }
    if let text = value as? String {
      return text
    }
    return "?"
  }
}
