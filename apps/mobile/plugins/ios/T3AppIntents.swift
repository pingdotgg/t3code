import AppIntents
internal import T3NativeControls

// App Shortcuts must be compiled into the app target; static pods do not ship App Intents metadata.

struct StartNewTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "New Task"
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    T3AppIntentInbox.deliver(T3AppIntentInbox.newTask)
    return .result()
  }
}

struct StartVoiceTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "New Voice Task"
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    T3AppIntentInbox.deliver(T3AppIntentInbox.voiceTask)
    return .result()
  }
}

struct T3AppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartNewTaskIntent(),
      phrases: [
        "Start a new task in \(.applicationName)",
        "New \(.applicationName) task",
      ],
      shortTitle: "New Task",
      systemImageName: "square.and.pencil"
    )
    AppShortcut(
      intent: StartVoiceTaskIntent(),
      phrases: [
        "Dictate a new task in \(.applicationName)",
        "New \(.applicationName) voice task",
      ],
      shortTitle: "New Voice Task",
      systemImageName: "mic"
    )
  }
}
