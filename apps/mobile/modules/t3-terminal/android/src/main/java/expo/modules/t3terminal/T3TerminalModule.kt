package expo.modules.t3terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3TerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3TerminalSurface")

    // Bumped when native hardware-keyboard handling changes; surfaced in the JS debug
    // logs so a stale native binary is distinguishable from a broken key pipeline.
    // `bufferStreamRevision` marks the incremental `bufferWrite` prop. A binary
    // without it only understands the old full-buffer prop, so a JS bundle
    // running against it shows an empty terminal until the app is rebuilt.
    //
    // `bufferStreamRevision` 标记增量 `bufferWrite` prop。没有这个常量的 binary
    // 只认旧的全量 buffer prop，配上新 JS 包会看到空终端，需要重新构建 app。
    Constants(
      "hardwareKeyRevision" to 2,
      "bufferStreamRevision" to 1,
    )

    View(T3TerminalView::class) {
      Prop("terminalKey") { view: T3TerminalView, terminalKey: String ->
        view.terminalKey = terminalKey
      }

      Prop("bufferWrite") { view: T3TerminalView, bufferWrite: TerminalBufferWriteRecord ->
        view.bufferWrite = bufferWrite
      }

      Prop("fontSize") { view: T3TerminalView, fontSize: Double ->
        view.fontSize = fontSize.toFloat()
      }

      Prop("focusRequest") { view: T3TerminalView, focusRequest: Double ->
        view.focusRequest = focusRequest
      }

      Prop("autoFocus") { view: T3TerminalView, autoFocus: Boolean ->
        view.autoFocus = autoFocus
      }

      Prop("appearanceScheme") { view: T3TerminalView, appearanceScheme: String ->
        view.appearanceScheme = appearanceScheme
      }

      Prop("themeConfig") { view: T3TerminalView, themeConfig: String ->
        view.themeConfig = themeConfig
      }

      Prop("backgroundColor") { view: T3TerminalView, backgroundColor: String ->
        view.backgroundColorHex = backgroundColor
      }

      Prop("foregroundColor") { view: T3TerminalView, foregroundColor: String ->
        view.foregroundColorHex = foregroundColor
      }

      Prop("mutedForegroundColor") { view: T3TerminalView, mutedForegroundColor: String ->
        view.mutedForegroundColorHex = mutedForegroundColor
      }

      Events("onInput", "onResize")

      OnViewDestroys { view: T3TerminalView ->
        view.cleanup()
      }
    }
  }
}
