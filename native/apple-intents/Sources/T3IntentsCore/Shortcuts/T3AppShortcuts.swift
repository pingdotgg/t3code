import AppIntents
import Foundation

@available(iOS 27.3, macOS 27.3, *)
public struct T3AppShortcuts: AppShortcutsProvider {
  public static let shortcutTileColor: ShortcutTileColor = .blue

  public static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: ListAttentionThreadsIntent(),
      phrases: [
        "Check threads needing attention in \(.applicationName)",
        "What needs attention in \(.applicationName)",
        "Check my agents in \(.applicationName)",
      ],
      shortTitle: "Attention Threads",
      systemImageName: "hand.raised.circle"
    )
    AppShortcut(
      intent: GetThreadStatusIntent(),
      phrases: [
        "Check thread status in \(.applicationName)",
        "Status of \(\.$thread) in \(.applicationName)",
      ],
      shortTitle: "Thread Status",
      systemImageName: "sparkles"
    )
    AppShortcut(
      intent: OpenThreadIntent(),
      phrases: [
        "Open \(\.$target) in \(.applicationName)",
        "Open thread in \(.applicationName)",
      ],
      shortTitle: "Open Thread",
      systemImageName: "bubble.left.and.bubble.right"
    )
    AppShortcut(
      intent: OpenProjectIntent(),
      phrases: [
        "Open \(\.$target) in \(.applicationName)",
        "Open project in \(.applicationName)",
      ],
      shortTitle: "Open Project",
      systemImageName: "folder"
    )
  }
}
