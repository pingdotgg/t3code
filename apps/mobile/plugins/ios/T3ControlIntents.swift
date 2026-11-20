import AppIntents
import Foundation

#if !T3_WIDGET_EXTENSION
import UIKit
#endif

@available(iOS 18.0, *)
struct T3StartTaskIntent: AppIntent {
  static var title: LocalizedStringResource = "Start a task"
  static var openAppWhenRun: Bool = true

  @MainActor
  func perform() async throws -> some IntentResult {
    // Control intents must also belong to the app so iOS runs this action in its process.
    #if !T3_WIDGET_EXTENSION
    if let url = URL(string: "__T3_SCHEME__://new") {
      await UIApplication.shared.open(url)
    }
    #endif
    return .result()
  }
}

@available(iOS 18.0, *)
struct T3OpenAppIntent: AppIntent {
  static var title: LocalizedStringResource = "Open T3 Code"
  static var openAppWhenRun: Bool = true

  func perform() async throws -> some IntentResult {
    return .result()
  }
}
