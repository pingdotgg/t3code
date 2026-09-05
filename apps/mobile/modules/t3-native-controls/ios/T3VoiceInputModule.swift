import AVFoundation
import ExpoModulesCore
import Speech

public final class T3VoiceInputModule: Module {
  private var session: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("T3VoiceInput")
    Events("onVoiceInput")

    Function("isAvailable") { () -> Bool in
      if #available(iOS 26.0, *) { return true }
      return false
    }
    AsyncFunction("prepare") { (locale: String) -> String? in
      guard #available(iOS 26.0, *) else { throw LiveVoiceError.unavailable }
      return try await LiveVoiceSession.prepare(locale: locale)
    }
    AsyncFunction("start") { (id: String, locale: String, limit: Double) in
      try await self.start(id: id, locale: locale, limit: limit)
    }
    AsyncFunction("stop") { (id: String) -> String in
      try await self.stop(id: id)
    }
    AsyncFunction("cancel") { (id: String) in
      await self.cancel(id: id)
    }
    OnDestroy {
      Task { @MainActor in
        if #available(iOS 26.0, *), let session = self.session as? LiveVoiceSession {
          await session.cancel()
          self.session = nil
        }
      }
    }
  }

  @MainActor
  private func start(id: String, locale: String, limit: Double) async throws {
    guard #available(iOS 26.0, *) else { throw LiveVoiceError.unavailable }
    guard session == nil else { throw LiveVoiceError.busy }
    let voice = LiveVoiceSession(id: id) { [weak self] event in
      self?.sendEvent("onVoiceInput", event)
    }
    session = voice
    do {
      try await voice.start(locale: locale, limit: limit)
    } catch {
      await voice.cancel()
      session = nil
      throw error
    }
  }

  @MainActor
  private func stop(id: String) async throws -> String {
    guard #available(iOS 26.0, *), let voice = session as? LiveVoiceSession,
      voice.id == id else { throw LiveVoiceError.unavailable }
    defer { if session === voice { session = nil } }
    return try await voice.stop()
  }

  @MainActor
  private func cancel(id: String) async {
    guard #available(iOS 26.0, *), let voice = session as? LiveVoiceSession,
      voice.id == id else { return }
    await voice.cancel()
    if session === voice { session = nil }
  }
}
