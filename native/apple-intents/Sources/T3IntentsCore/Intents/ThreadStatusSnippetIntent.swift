import AppIntents
import Foundation
import SwiftUI

@available(iOS 27.3, macOS 27.3, *)
public struct ThreadStatusSnippetIntent: SnippetIntent, Sendable {
  public static let title: LocalizedStringResource = "Thread Status Card"
  public static let isDiscoverable: Bool = false

  @Parameter(title: "Thread")
  public var thread: ThreadEntity

  @Dependency
  private var store: T3IndexStore

  public init() {}

  public init(thread: ThreadEntity) {
    self.thread = thread
  }

  public func perform() async throws -> some IntentResult & ShowsSnippetView {
    let fresh = store.thread(id: thread.id).map(ThreadEntity.init(record:)) ?? thread
    return .result(
      view: ThreadStatusInteractiveSnippetView(
        thread: fresh,
        freshness: T3StatusFreshness.of(environmentId: fresh.environmentId, in: store)
      )
    )
  }
}

@available(iOS 27.3, macOS 27.3, *)
private struct ThreadStatusInteractiveSnippetView: View {
  let thread: ThreadEntity
  let freshness: T3StatusFreshness

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ThreadStatusCardView(thread: thread, isCompact: false, freshness: freshness)
      HStack(spacing: 8) {
        Button(intent: OpenThreadIntent(target: thread)) {
          Label("Open", systemImage: "arrow.up.forward.app")
        }
        .buttonStyle(.borderedProminent)

        if thread.status == .running {
          Button(intent: StopThreadIntent(thread: thread)) {
            Label("Stop", systemImage: "stop.circle")
          }
          .buttonStyle(.bordered)
        } else if !thread.isSettled {
          Button(intent: OrganizeThreadIntent(thread: thread, action: .settle)) {
            Label("Settle", systemImage: "checkmark.circle")
          }
          .buttonStyle(.bordered)
        }
      }
      .padding(.horizontal, 12)
      .padding(.bottom, 10)
    }
  }
}
