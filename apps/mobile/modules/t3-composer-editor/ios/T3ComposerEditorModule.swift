import ExpoModulesCore

public class T3ComposerEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3ComposerEditor")

    View(T3ComposerEditorView.self) {
      Prop("value") { (view: T3ComposerEditorView, value: String) in
        view.setValue(value)
      }
      Prop("tokensJson") { (view: T3ComposerEditorView, tokensJson: String) in
        view.setTokensJson(tokensJson)
      }
      Prop("selectionJson") { (view: T3ComposerEditorView, selectionJson: String) in
        view.setSelectionJson(selectionJson)
      }
      Prop("themeJson") { (view: T3ComposerEditorView, themeJson: String) in
        view.setThemeJson(themeJson)
      }
      Prop("placeholder") { (view: T3ComposerEditorView, placeholder: String) in
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { (view: T3ComposerEditorView, fontFamily: String) in
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { (view: T3ComposerEditorView, fontSize: Double) in
        view.setFontSize(CGFloat(fontSize))
      }
      Prop("lineHeight") { (view: T3ComposerEditorView, lineHeight: Double) in
        view.setLineHeight(CGFloat(lineHeight))
      }
      Prop("contentInsetVertical") { (view: T3ComposerEditorView, contentInsetVertical: Double) in
        view.setContentInsetVertical(CGFloat(contentInsetVertical))
      }
      Prop("editable") { (view: T3ComposerEditorView, editable: Bool) in
        view.setEditable(editable)
      }
      Prop("scrollEnabled") { (view: T3ComposerEditorView, scrollEnabled: Bool) in
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { (view: T3ComposerEditorView, autoFocus: Bool) in
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { (view: T3ComposerEditorView, autoCorrect: Bool) in
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { (view: T3ComposerEditorView, spellCheck: Bool) in
        view.setSpellCheck(spellCheck)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerPasteImages",
        "onComposerContentSizeChange"
      )

      AsyncFunction("focus") { (view: T3ComposerEditorView) in
        view.focusEditor()
      }
      AsyncFunction("blur") { (view: T3ComposerEditorView) in
        view.blurEditor()
      }
      AsyncFunction("setSelection") { (view: T3ComposerEditorView, start: Int, end: Int) in
        view.setSelection(start: start, end: end)
      }
    }
  }
}
