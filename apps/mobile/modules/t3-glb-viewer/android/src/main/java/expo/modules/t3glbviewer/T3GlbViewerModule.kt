package expo.modules.t3glbviewer

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3GlbViewerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3GlbViewer")

    View(T3GlbViewerView::class) {
      Prop("uri") { view: T3GlbViewerView, uri: String ->
        view.setModelUri(uri)
      }

      Prop("backgroundColor") { view: T3GlbViewerView, backgroundColor: String ->
        view.setViewerBackgroundColor(backgroundColor)
      }

      Events("onLoadStart", "onLoad", "onError")

      OnViewDestroys { view: T3GlbViewerView ->
        view.cleanup()
      }
    }
  }
}
