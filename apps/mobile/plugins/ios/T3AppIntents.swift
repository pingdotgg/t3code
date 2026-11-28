import AppIntents
internal import T3NativeControls

struct StartDictationIntent: AppIntent {
  static let title: LocalizedStringResource = "Start Dictation"
  static let description = IntentDescription("Opens a new thread with dictation already listening.")
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    T3DictationIntentInbox.deliver()
    return .result()
  }
}

struct T3AppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartDictationIntent(),
      phrases: [
        "Start dictation in \(.applicationName)",
        "Dictate in \(.applicationName)",
        "New \(.applicationName) voice thread",
      ],
      shortTitle: "Start Dictation",
      systemImageName: "mic"
    )
  }
}
