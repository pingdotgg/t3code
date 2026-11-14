import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 18.0, *)
struct T3StartTaskControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "T3StartTaskControl") {
      ControlWidgetButton(action: T3StartTaskIntent()) {
        Label("Start a task", systemImage: "square.and.pencil")
      }
    }
    .displayName("Start a task")
    .description("Start a new task in T3 Code.")
  }
}
