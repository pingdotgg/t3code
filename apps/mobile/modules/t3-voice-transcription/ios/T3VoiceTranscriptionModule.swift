import ExpoModulesCore
import Foundation

public class T3VoiceTranscriptionModule: Module {
  private let models = DeviceSpeechModelStore()

  private func publishModelStates(_ snapshot: DeviceSpeechModelStore.Snapshot) {
    sendEvent("deviceSpeechModelStates", snapshot.payload)
  }

  public func definition() -> ModuleDefinition {
    Name("T3VoiceTranscription")
    Events("deviceSpeechModelStates")

    OnCreate {
      let models = self.models
      Task { await models.prepareStorage() }
    }

    OnDestroy {
      let models = self.models
      Task { await models.stop() }
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

    Function("getDeviceSpeechCatalog") { DeviceSpeechCatalog.models.map(\.payload) }

    AsyncFunction("getDeviceSpeechModelStates") { () async -> [String: Any] in
      await self.models.snapshot(publish: self.publishModelStates).payload
    }

    AsyncFunction("startDeviceSpeechModelDownload") { (modelId: String) async throws in
      try await self.models.startDownload(modelId) { [weak self] snapshot in
        self?.publishModelStates(snapshot)
      }
    }

    AsyncFunction("cancelDeviceSpeechModelDownload") { (modelId: String) async in
      await self.models.cancelDownload(modelId, publish: self.publishModelStates)
    }

    AsyncFunction("removeDeviceSpeechModel") { (modelId: String) async throws in
      try await self.models.remove(modelId, publish: self.publishModelStates)
    }

    AsyncFunction("transcribeWithDeviceSpeechModel") {
      (modelId: String, id: String, uri: URL) async throws -> [String: String] in
      try await self.models.transcribe(modelId: modelId, id: id, file: uri).payload
    }

    AsyncFunction("cancelDeviceSpeechInference") { (id: String) async in
      await self.models.cancelInference(id: id)
    }
  }
}
