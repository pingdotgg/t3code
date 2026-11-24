import AppIntents
import Foundation

#if os(macOS)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

@available(iOS 27.3, macOS 27.3, *)
public struct OpenThreadIntent: OpenIntent, Sendable {
  public static let title: LocalizedStringResource = "Open Thread"
  public static let description = IntentDescription(
    "Open a coding agent thread in T3 Code.",
    categoryName: "Threads"
  )
  public static let supportedModes: IntentModes = .foreground

  @Parameter(
    title: "Thread",
    description: "The T3 Code thread to open."
  )
  public var target: ThreadEntity

  public static var parameterSummary: some ParameterSummary {
    Summary("Open \(\.$target)")
  }

  public init() {}

  public init(target: ThreadEntity) {
    self.target = target
  }

  @MainActor
  public func perform() async throws -> some IntentResult {
    let encodedEnv = target.environmentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? target.environmentId
    let encodedThread = target.threadId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? target.threadId
    if let url = URL(string: "\(T3IntentsConfig.urlScheme)://threads/\(encodedEnv)/\(encodedThread)") {
      T3DeepLinkOpener.open(url)
    }
    return .result()
  }
}

public enum T3DeepLinkOpener {
  @MainActor
  public static func open(_ url: URL) {
    #if os(macOS)
    NSWorkspace.shared.open(url)
    #elseif canImport(UIKit)
    if let handler = T3IntentsRuntime.shared.onOpenURL {
      handler(url)
    }
    #endif
  }
}
