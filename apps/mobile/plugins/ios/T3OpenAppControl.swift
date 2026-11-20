import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 18.0, *)
struct T3OpenAppControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "T3OpenAppControl") {
      ControlWidgetButton(action: T3OpenAppIntent()) {
        Label("Open T3 Code", image: "T3ControlMark")
      }
    }
    .displayName("Open T3 Code")
    .description("Open T3 Code.")
  }
}
