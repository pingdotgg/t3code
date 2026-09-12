import SwiftUI
import WidgetKit

@main
struct T3CodeWidgetBundle: WidgetBundle {
    var body: some Widget {
        T3TaskLiveActivity()
        T3RecentTasksWidget()
    }
}
