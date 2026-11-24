import ExpoModulesCore
import Foundation

public class T3VoiceTranscriptionModule: Module {
  private let parakeetUltra = ParakeetUltraModel()

  private func publishParakeetUltraState(_ snapshot: ParakeetUltraModel.Snapshot) {
    sendEvent("parakeetUltraState", snapshot.payload)
  }

  public func definition() -> ModuleDefinition {
    Name("T3VoiceTranscription")
    Events("parakeetUltraState")

    OnCreate {
      let model = self.parakeetUltra
      Task { await model.pruneSupersededModels() }
    }

    OnDestroy {
      let model = self.parakeetUltra
      Task { await model.stop() }
    }

    Function("isAppleSpeechAvailable") {
      if #available(iOS 26, *) { return AppleSpeechEngine.isAvailable }
      return false
    }

    AsyncFunction("prepareAppleSpeech") { (locale: String) async throws -> String? in
      guard #available(iOS 26, *) else { throw CocoaError(.featureUnsupported) }
      do {
        return try await AppleSpeechEngine.prepare(locale)
      } catch AppleSpeechEngine.Failure.unsupportedLocale {
        return nil
      }
    }

    AsyncFunction("transcribeWithAppleSpeech") {
      (uri: URL, locale: String) async throws -> String in
      guard #available(iOS 26, *) else { throw CocoaError(.featureUnsupported) }
      return try await AppleSpeechEngine.transcribe(locale, file: uri)
    }

    AsyncFunction("decodeRecording") { (uri: URL) throws -> Data in
      try VoiceRecordingPCM.signed16(file: uri)
    }

    Function("getParakeetUltraSize") { ParakeetUltraArtifact.byteCount }

    AsyncFunction("getParakeetUltraState") { () async -> [String: Any] in
      await self.parakeetUltra.snapshot(publish: self.publishParakeetUltraState).payload
    }

    AsyncFunction("startParakeetUltraDownload") { () async in
      await self.parakeetUltra.startDownload { [weak self] snapshot in
        self?.publishParakeetUltraState(snapshot)
      }
    }

    AsyncFunction("cancelParakeetUltraDownload") { () async in
      await self.parakeetUltra.cancelDownload(publish: self.publishParakeetUltraState)
    }

    AsyncFunction("removeParakeetUltra") { () async throws in
      try await self.parakeetUltra.remove(publish: self.publishParakeetUltraState)
    }

    AsyncFunction("transcribeWithParakeetUltra") { (id: String, uri: URL) async throws -> String in
      try await self.parakeetUltra.transcribe(
        id: id, file: uri, publish: self.publishParakeetUltraState)
    }

    AsyncFunction("cancelParakeetUltraTranscription") { (id: String) async in
      await self.parakeetUltra.cancelInference(id: id)
    }
  }
}
