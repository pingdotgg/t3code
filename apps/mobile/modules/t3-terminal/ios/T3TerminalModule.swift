import ExpoModulesCore

public class T3TerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3TerminalSurface")

    // Bumped when native hardware-keyboard handling changes; surfaced in the JS debug
    // logs so a stale native binary is distinguishable from a broken key pipeline.
    // `bufferStreamRevision` marks the incremental `bufferWrite` prop. A binary
    // without it only understands the old full-buffer prop, so a JS bundle
    // running against it shows an empty terminal until the app is rebuilt.
    //
    // `bufferStreamRevision` 标记增量 `bufferWrite` prop。没有这个常量的 binary
    // 只认旧的全量 buffer prop，配上新 JS 包会看到空终端，需要重新构建 app。
    Constants([
      "hardwareKeyRevision": 3,
      "bufferStreamRevision": 1,
    ])

    View(T3TerminalView.self) {
      Prop("terminalKey") { (view: T3TerminalView, terminalKey: String) in
        view.terminalKey = terminalKey
      }

      Prop("bufferWrite") { (view: T3TerminalView, bufferWrite: TerminalBufferWriteRecord) in
        view.bufferWrite = bufferWrite
      }

      Prop("fontSize") { (view: T3TerminalView, fontSize: Double) in
        view.fontSize = CGFloat(fontSize)
      }

      Prop("focusRequest") { (view: T3TerminalView, focusRequest: Double) in
        view.focusRequest = focusRequest
      }

      Prop("autoFocus") { (view: T3TerminalView, autoFocus: Bool) in
        view.autoFocus = autoFocus
      }

      Prop("appearanceScheme") { (view: T3TerminalView, appearanceScheme: String) in
        view.appearanceScheme = appearanceScheme
      }

      Prop("themeConfig") { (view: T3TerminalView, themeConfig: String) in
        view.themeConfig = themeConfig
      }

      Prop("backgroundColor") { (view: T3TerminalView, backgroundColor: String) in
        view.backgroundColorHex = backgroundColor
      }

      Prop("foregroundColor") { (view: T3TerminalView, foregroundColor: String) in
        view.foregroundColorHex = foregroundColor
      }

      Prop("mutedForegroundColor") { (view: T3TerminalView, mutedForegroundColor: String) in
        view.mutedForegroundColorHex = mutedForegroundColor
      }

      Events("onInput", "onResize")
    }
  }
}
