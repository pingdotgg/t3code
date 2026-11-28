// t3-apple-speech available                      -> {"value":"en-US,fr-FR,..."}
// t3-apple-speech prepare <locale>               -> {"value":"en-US"}  (resolved locale)
// t3-apple-speech transcribe <locale> <wav-path> -> {"value":"..."}    (transcript)
// Exit codes are consumed by AppleSpeech.ts; failures print one message line to stderr.

import Foundation

private enum ExitCode: Int32 {
  case failure = 1
  case unsupportedLocale = 2
  case unavailable = 3
  case usage = 64
}

@main
struct AppleSpeech {
  static func main() async {
    let arguments = Array(CommandLine.arguments.dropFirst())
    do {
      switch (arguments.first, arguments.count) {
      case ("available", 1):
        try write(try await AppleSpeechEngine.supportedLocales().joined(separator: ","))
      case ("prepare", 2):
        try write(try await AppleSpeechEngine.prepare(arguments[1]))
      case ("transcribe", 3):
        try write(try await AppleSpeechEngine.transcribe(arguments[1], file: URL(fileURLWithPath: arguments[2])))
      default:
        fail(.usage, "Unknown command.")
      }
    } catch let failure as AppleSpeechEngine.Failure {
      switch failure {
      case .unsupportedLocale: fail(.unsupportedLocale, failure.localizedDescription)
      case .unavailable: fail(.unavailable, failure.localizedDescription)
      case .unknownAssetStatus: fail(.failure, failure.localizedDescription)
      }
    } catch {
      fail(.failure, error.localizedDescription)
    }
  }

  private static func write(_ value: String) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["value": value]))
  }

  private static func fail(_ code: ExitCode, _ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code.rawValue)
  }
}
