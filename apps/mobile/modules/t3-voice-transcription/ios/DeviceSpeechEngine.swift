import CTranscribe
import Foundation
import Synchronization

final class SpeechInferenceCancellation: Sendable {
  private let cancelled = Mutex(false)

  var isCancelled: Bool { cancelled.withLock { $0 } }

  func cancel() {
    cancelled.withLock { $0 = true }
  }

  func check() throws {
    if isCancelled { throw CancellationError() }
  }
}

enum DeviceSpeechEngine {
  struct Transcript: Sendable {
    let text: String
    let language: String?

    var payload: [String: String] {
      var result = ["text": text]
      result["language"] = language
      return result
    }
  }

  private struct Failure: Error {
    let status: transcribe_status
  }

  static func transcribe(file: URL, model: URL, cancellation: SpeechInferenceCancellation) throws
    -> Transcript
  {
    try cancellation.check()
    let samples = try VoiceRecordingPCM.float32(file: file, checkCancellation: cancellation.check)
    do {
      return try run(samples, model: model, backend: TRANSCRIBE_BACKEND_AUTO, cancellation: cancellation)
    } catch let error as Failure where error.status == TRANSCRIBE_ERR_BACKEND {
      return try run(samples, model: model, backend: TRANSCRIBE_BACKEND_CPU, cancellation: cancellation)
    }
  }

  private static func run(
    _ samples: [Float], model: URL, backend: transcribe_backend_request,
    cancellation: SpeechInferenceCancellation
  ) throws -> Transcript {
    try cancellation.check()

    var loadParameters = transcribe_model_load_params()
    transcribe_model_load_params_init(&loadParameters)
    loadParameters.backend = backend
    var opened: OpaquePointer?
    try check(transcribe_open(model.path, &loadParameters, nil, &opened))
    guard let session = opened else { throw CocoaError(.fileReadCorruptFile) }
    defer { transcribe_session_free(session) }
    try cancellation.check()

    // The run can call back on this pointer until it returns. Clear it before releasing the retain.
    let context = Unmanaged.passRetained(cancellation)
    transcribe_set_abort_callback(
      session,
      { data in
        guard let data else { return false }
        return Unmanaged<SpeechInferenceCancellation>.fromOpaque(data).takeUnretainedValue()
          .isCancelled
      }, context.toOpaque())
    defer {
      transcribe_set_abort_callback(session, nil, nil)
      context.release()
    }

    var parameters = transcribe_run_params()
    transcribe_run_params_init(&parameters)
    parameters.timestamps = TRANSCRIBE_TIMESTAMPS_NONE
    let hint = try languageHint(session)
    let status = samples.withUnsafeBufferPointer { buffer in
      if let hint {
        return hint.withCString { value in
          parameters.language = value
          return transcribe_run(session, buffer.baseAddress, Int32(buffer.count), &parameters)
        }
      }
      return transcribe_run(session, buffer.baseAddress, Int32(buffer.count), &parameters)
    }
    try cancellation.check()
    try check(status)
    guard !transcribe_was_truncated(session) else { throw CocoaError(.fileReadTooLarge) }
    let language = transcribe_detected_language(session).flatMap { code in
      let language = String(cString: code)
      return language.isEmpty ? nil : language
    }
    return Transcript(
      text: transcribe_full_text(session).map { String(cString: $0) } ?? "",
      language: language ?? hint)
  }

  private static func languageHint(_ session: OpaquePointer) throws -> String? {
    var capabilities = transcribe_capabilities()
    transcribe_capabilities_init(&capabilities)
    try check(transcribe_model_get_capabilities(transcribe_get_model(session), &capabilities))
    guard !capabilities.supports_language_detect, let languages = capabilities.languages else {
      return nil
    }
    let codes = (0..<Int(capabilities.n_languages)).compactMap {
      languages[$0].map { String(cString: $0) }
    }
    for preferred in Locale.preferredLanguages + ["en"] {
      let tag = preferred.lowercased().replacingOccurrences(of: "_", with: "-")
      if let exact = codes.first(where: { $0.lowercased() == tag }) { return exact }
      let base = tag.split(separator: "-").first
      if let match = codes.first(where: { $0.lowercased().split(separator: "-").first == base }) {
        return match
      }
    }
    return codes.first
  }

  private static func check(_ status: transcribe_status) throws {
    guard status == TRANSCRIBE_OK else {
      throw Failure(status: status)
    }
  }
}
