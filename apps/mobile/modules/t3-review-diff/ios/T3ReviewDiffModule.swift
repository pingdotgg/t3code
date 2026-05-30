import ExpoModulesCore

public class T3ReviewDiffModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3ReviewDiffSurface")

    View(T3ReviewDiffView.self) {
      Prop("rowsJson") { (view: T3ReviewDiffView, rowsJson: String) in
        view.setRowsJson(rowsJson)
      }

      Prop("tokensJson") { (view: T3ReviewDiffView, tokensJson: String) in
        view.setTokensJson(tokensJson)
      }

      Prop("tokensPatchJson") { (view: T3ReviewDiffView, tokensPatchJson: String) in
        view.setTokensPatchJson(tokensPatchJson)
      }

      Prop("tokensResetKey") { (view: T3ReviewDiffView, tokensResetKey: String) in
        view.setTokensResetKey(tokensResetKey)
      }

      Prop("collapsedFileIdsJson") { (view: T3ReviewDiffView, collapsedFileIdsJson: String) in
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }

      Prop("viewedFileIdsJson") { (view: T3ReviewDiffView, viewedFileIdsJson: String) in
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }

      Prop("selectedRowIdsJson") { (view: T3ReviewDiffView, selectedRowIdsJson: String) in
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }

      Prop("collapsedCommentIdsJson") { (view: T3ReviewDiffView, collapsedCommentIdsJson: String) in
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }

      Prop("appearanceScheme") { (view: T3ReviewDiffView, appearanceScheme: String) in
        view.setAppearanceScheme(appearanceScheme)
      }

      Prop("themeJson") { (view: T3ReviewDiffView, themeJson: String) in
        view.setThemeJson(themeJson)
      }

      Prop("styleJson") { (view: T3ReviewDiffView, styleJson: String) in
        view.setStyleJson(styleJson)
      }

      Prop("rowHeight") { (view: T3ReviewDiffView, rowHeight: Double) in
        view.setRowHeight(CGFloat(rowHeight))
      }

      Prop("contentWidth") { (view: T3ReviewDiffView, contentWidth: Double) in
        view.setContentWidth(CGFloat(contentWidth))
      }

      Events("onDebug", "onToggleFile", "onToggleViewedFile", "onPressLine", "onToggleComment")
    }
  }
}
