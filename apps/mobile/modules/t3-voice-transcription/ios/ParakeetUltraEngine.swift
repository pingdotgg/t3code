import CTranscribe
import Foundation
import Synchronization

final class ParakeetUltraCancellation: Sendable {
  private let cancelled = Mutex(false)

  var isCancelled: Bool { cancelled.withLock { $0 } }

  func cancel() {
    cancelled.withLock { $0 = true }
  }

  func check() throws {
    if isCancelled { throw CancellationError() }
  }
}

enum ParakeetUltraEngine {
  private struct Failure: Error {
    let status: transcribe_status
  }

  static func transcribe(file: URL, model: URL, cancellation: ParakeetUltraCancellation) throws
    -> String
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
    cancellation: ParakeetUltraCancellation
  ) throws -> String {
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
        return Unmanaged<ParakeetUltraCancellation>.fromOpaque(data).takeUnretainedValue()
          .isCancelled
      }, context.toOpaque())
    defer {
      transcribe_set_abort_callback(session, nil, nil)
      context.release()
    }

    var parameters = transcribe_run_params()
    transcribe_run_params_init(&parameters)
    parameters.timestamps = TRANSCRIBE_TIMESTAMPS_NONE
    let status = samples.withUnsafeBufferPointer {
      transcribe_run(session, $0.baseAddress, Int32($0.count), &parameters)
    }
    try cancellation.check()
    try check(status)
    guard !transcribe_was_truncated(session) else { throw CocoaError(.fileReadTooLarge) }
    return transcribe_full_text(session).map { String(cString: $0) } ?? ""
  }

  private static func check(_ status: transcribe_status) throws {
    guard status == TRANSCRIBE_OK else {
      throw Failure(status: status)
    }
  }
}
