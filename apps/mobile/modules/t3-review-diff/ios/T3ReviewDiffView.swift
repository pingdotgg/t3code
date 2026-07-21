import ExpoModulesCore
import UIKit

private struct ReviewDiffNativeRow: Decodable {
  let kind: String
  let id: String
  let fileId: String?
  let filePath: String?
  let previousPath: String?
  let changeType: String?
  let additions: Int?
  let deletions: Int?
  let text: String?
  let content: String?
  let change: String?
  let oldLineNumber: Int?
  let newLineNumber: Int?
  let wordDiffRanges: [ReviewDiffNativeWordDiffRange]?
  let commentText: String?
  let commentRangeLabel: String?
  let commentSectionTitle: String?
}

private struct ReviewDiffNativeWordDiffRange: Decodable {
  let start: Int
  let end: Int
}

private struct ReviewDiffNativeToken: Decodable {
  let content: String
  let color: String?
  let fontStyle: Int?
}

private struct ReviewDiffNativeTokenPatch: Decodable {
  let resetKey: String?
  let chunkIndex: Int?
  let tokensByRowId: [String: [ReviewDiffNativeToken]]?
}

private struct ReviewDiffNativeThemePayload: Decodable {
  let background: String?
  let text: String?
  let mutedText: String?
  let headerBackground: String?
  let border: String?
  let hunkBackground: String?
  let hunkText: String?
  let addBackground: String?
  let deleteBackground: String?
  let addBar: String?
  let deleteBar: String?
  let addText: String?
  let deleteText: String?
}

private struct ReviewDiffNativeTheme {
  let background: UIColor
  let text: UIColor
  let mutedText: UIColor
  let headerBackground: UIColor
  let border: UIColor
  let hunkBackground: UIColor
  let hunkText: UIColor
  let addBackground: UIColor
  let deleteBackground: UIColor
  let addBar: UIColor
  let deleteBar: UIColor
  let addText: UIColor
  let deleteText: UIColor

  static func resolve(_ scheme: String) -> ReviewDiffNativeTheme {
    resolve(scheme, payload: nil)
  }

  static func resolve(
    _ scheme: String,
    payload: ReviewDiffNativeThemePayload?
  ) -> ReviewDiffNativeTheme {
    let fallback = fallback(scheme)
    guard let payload else {
      return fallback
    }

    return ReviewDiffNativeTheme(
      background: UIColor(reviewDiffHex: payload.background) ?? fallback.background,
      text: UIColor(reviewDiffHex: payload.text) ?? fallback.text,
      mutedText: UIColor(reviewDiffHex: payload.mutedText) ?? fallback.mutedText,
      headerBackground: UIColor(reviewDiffHex: payload.headerBackground) ?? fallback.headerBackground,
      border: UIColor(reviewDiffHex: payload.border) ?? fallback.border,
      hunkBackground: UIColor(reviewDiffHex: payload.hunkBackground) ?? fallback.hunkBackground,
      hunkText: UIColor(reviewDiffHex: payload.hunkText) ?? fallback.hunkText,
      addBackground: UIColor(reviewDiffHex: payload.addBackground) ?? fallback.addBackground,
      deleteBackground: UIColor(reviewDiffHex: payload.deleteBackground) ?? fallback.deleteBackground,
      addBar: UIColor(reviewDiffHex: payload.addBar) ?? fallback.addBar,
      deleteBar: UIColor(reviewDiffHex: payload.deleteBar) ?? fallback.deleteBar,
      addText: UIColor(reviewDiffHex: payload.addText) ?? fallback.addText,
      deleteText: UIColor(reviewDiffHex: payload.deleteText) ?? fallback.deleteText
    )
  }

  private static func fallback(_ scheme: String) -> ReviewDiffNativeTheme {
    if scheme == "dark" {
      return ReviewDiffNativeTheme(
        background: UIColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1),
        text: UIColor(red: 0.90, green: 0.90, blue: 0.90, alpha: 1),
        mutedText: UIColor(red: 0.52, green: 0.52, blue: 0.52, alpha: 1),
        headerBackground: UIColor(red: 0.10, green: 0.10, blue: 0.10, alpha: 1),
        border: UIColor(red: 0.16, green: 0.16, blue: 0.16, alpha: 1),
        hunkBackground: UIColor(red: 0.03, green: 0.14, blue: 0.18, alpha: 1),
        hunkText: UIColor(red: 0.41, green: 0.82, blue: 1.00, alpha: 1),
        addBackground: UIColor(red: 0.02, green: 0.16, blue: 0.10, alpha: 1),
        deleteBackground: UIColor(red: 0.18, green: 0.05, blue: 0.08, alpha: 1),
        addBar: UIColor(red: 0.02, green: 0.82, blue: 0.54, alpha: 1),
        deleteBar: UIColor(red: 1.00, green: 0.36, blue: 0.50, alpha: 1),
        addText: UIColor(red: 0.10, green: 0.84, blue: 0.56, alpha: 1),
        deleteText: UIColor(red: 1.00, green: 0.38, blue: 0.52, alpha: 1)
      )
    }

    return ReviewDiffNativeTheme(
      background: UIColor.white,
      text: UIColor(red: 0.16, green: 0.16, blue: 0.16, alpha: 1),
      mutedText: UIColor(red: 0.47, green: 0.47, blue: 0.47, alpha: 1),
      headerBackground: UIColor.white,
      border: UIColor(red: 0.88, green: 0.88, blue: 0.90, alpha: 1),
      hunkBackground: UIColor(red: 0.83, green: 0.92, blue: 0.98, alpha: 1),
      hunkText: UIColor(red: 0.00, green: 0.45, blue: 0.74, alpha: 1),
      addBackground: UIColor(red: 0.85, green: 0.94, blue: 0.92, alpha: 1),
      deleteBackground: UIColor(red: 0.96, green: 0.85, blue: 0.90, alpha: 1),
      addBar: UIColor(red: 0.02, green: 0.80, blue: 0.52, alpha: 1),
      deleteBar: UIColor(red: 1.00, green: 0.34, blue: 0.48, alpha: 1),
      addText: UIColor(red: 0.00, green: 0.56, blue: 0.34, alpha: 1),
      deleteText: UIColor(red: 0.90, green: 0.10, blue: 0.24, alpha: 1)
    )
  }
}

private struct ReviewDiffNativeStylePayload: Decodable {
  let rowHeight: Double?
  let contentWidth: Double?
  let changeBarWidth: Double?
  let gutterWidth: Double?
  let codePadding: Double?
  let textVerticalInset: Double?
  let fileHeaderHeight: Double?
  let fileHeaderHorizontalMargin: Double?
  let fileHeaderVerticalMargin: Double?
  let fileHeaderCornerRadius: Double?
  let fileHeaderHorizontalPadding: Double?
  let fileHeaderPathRightPadding: Double?
  let fileHeaderCountColumnWidth: Double?
  let fileHeaderCountGap: Double?
  let codeFontSize: Double?
  let codeFontWeight: String?
  let lineNumberFontSize: Double?
  let lineNumberFontWeight: String?
  let hunkFontSize: Double?
  let hunkFontWeight: String?
  let fileHeaderFontSize: Double?
  let fileHeaderFontWeight: String?
  let fileHeaderMetaFontSize: Double?
  let fileHeaderMetaFontWeight: String?
  let fileHeaderSubtextFontSize: Double?
  let fileHeaderSubtextFontWeight: String?
  let fileHeaderStatusFontSize: Double?
  let fileHeaderStatusFontWeight: String?
  let emptyStateFontSize: Double?
  let emptyStateFontWeight: String?
}

private struct ReviewDiffNativeStyle {
  let rowHeight: CGFloat
  let contentWidth: CGFloat
  let changeBarWidth: CGFloat
  let gutterWidth: CGFloat
  let codePadding: CGFloat
  let textVerticalInset: CGFloat
  let fileHeaderHeight: CGFloat
  let fileHeaderHorizontalMargin: CGFloat
  let fileHeaderVerticalMargin: CGFloat
  let fileHeaderCornerRadius: CGFloat
  let fileHeaderHorizontalPadding: CGFloat
  let fileHeaderPathRightPadding: CGFloat
  let fileHeaderCountColumnWidth: CGFloat
  let fileHeaderCountGap: CGFloat
  let codeFontSize: CGFloat
  let codeFontWeight: UIFont.Weight
  let lineNumberFontSize: CGFloat
  let lineNumberFontWeight: UIFont.Weight
  let hunkFontSize: CGFloat
  let hunkFontWeight: UIFont.Weight
  let fileHeaderFontSize: CGFloat
  let fileHeaderFontWeight: UIFont.Weight
  let fileHeaderMetaFontSize: CGFloat
  let fileHeaderMetaFontWeight: UIFont.Weight
  let fileHeaderSubtextFontSize: CGFloat
  let fileHeaderSubtextFontWeight: UIFont.Weight
  let fileHeaderStatusFontSize: CGFloat
  let fileHeaderStatusFontWeight: UIFont.Weight
  let emptyStateFontSize: CGFloat
  let emptyStateFontWeight: UIFont.Weight

  static func resolve(_ payload: ReviewDiffNativeStylePayload?) -> ReviewDiffNativeStyle {
    ReviewDiffNativeStyle(
      rowHeight: metric(payload?.rowHeight, fallback: 24),
      contentWidth: metric(payload?.contentWidth, fallback: 2800),
      changeBarWidth: nonNegativeMetric(payload?.changeBarWidth, fallback: 4),
      gutterWidth: metric(payload?.gutterWidth, fallback: 50),
      codePadding: metric(payload?.codePadding, fallback: 8),
      textVerticalInset: metric(payload?.textVerticalInset, fallback: 3),
      fileHeaderHeight: metric(payload?.fileHeaderHeight, fallback: 54),
      fileHeaderHorizontalMargin: metric(payload?.fileHeaderHorizontalMargin, fallback: 8),
      fileHeaderVerticalMargin: metric(payload?.fileHeaderVerticalMargin, fallback: 6),
      fileHeaderCornerRadius: metric(payload?.fileHeaderCornerRadius, fallback: 10),
      fileHeaderHorizontalPadding: metric(payload?.fileHeaderHorizontalPadding, fallback: 12),
      fileHeaderPathRightPadding: metric(payload?.fileHeaderPathRightPadding, fallback: 128),
      fileHeaderCountColumnWidth: metric(payload?.fileHeaderCountColumnWidth, fallback: 42),
      fileHeaderCountGap: metric(payload?.fileHeaderCountGap, fallback: 6),
      codeFontSize: metric(payload?.codeFontSize, fallback: 12),
      codeFontWeight: fontWeight(payload?.codeFontWeight, fallback: .bold),
      lineNumberFontSize: metric(payload?.lineNumberFontSize, fallback: 11),
      lineNumberFontWeight: fontWeight(payload?.lineNumberFontWeight, fallback: .bold),
      hunkFontSize: metric(payload?.hunkFontSize, fallback: 12),
      hunkFontWeight: fontWeight(payload?.hunkFontWeight, fallback: .bold),
      fileHeaderFontSize: metric(payload?.fileHeaderFontSize, fallback: 13),
      fileHeaderFontWeight: fontWeight(payload?.fileHeaderFontWeight, fallback: .bold),
      fileHeaderMetaFontSize: metric(payload?.fileHeaderMetaFontSize, fallback: 12),
      fileHeaderMetaFontWeight: fontWeight(payload?.fileHeaderMetaFontWeight, fallback: .bold),
      fileHeaderSubtextFontSize: metric(payload?.fileHeaderSubtextFontSize, fallback: 11),
      fileHeaderSubtextFontWeight: fontWeight(payload?.fileHeaderSubtextFontWeight, fallback: .medium),
      fileHeaderStatusFontSize: metric(payload?.fileHeaderStatusFontSize, fallback: 10),
      fileHeaderStatusFontWeight: fontWeight(payload?.fileHeaderStatusFontWeight, fallback: .semibold),
      emptyStateFontSize: metric(payload?.emptyStateFontSize, fallback: 13),
      emptyStateFontWeight: fontWeight(payload?.emptyStateFontWeight, fallback: .semibold)
    )
  }

  private static func metric(_ value: Double?, fallback: CGFloat) -> CGFloat {
    guard let value, value.isFinite, value > 0 else {
      return fallback
    }
    return CGFloat(value)
  }

  private static func nonNegativeMetric(_ value: Double?, fallback: CGFloat) -> CGFloat {
    guard let value, value.isFinite, value >= 0 else {
      return fallback
    }
    return CGFloat(value)
  }

  private static func fontWeight(_ value: String?, fallback: UIFont.Weight) -> UIFont.Weight {
    switch value?.lowercased() {
    case "ultralight", "ultra-light":
      return .ultraLight
    case "thin":
      return .thin
    case "light":
      return .light
    case "regular":
      return .regular
    case "medium":
      return .medium
    case "semibold", "semi-bold":
      return .semibold
    case "bold":
      return .bold
    case "heavy":
      return .heavy
    case "black":
      return .black
    default:
      return fallback
    }
  }

  func applyingOverrides(rowHeight: CGFloat?, contentWidth: CGFloat?) -> ReviewDiffNativeStyle {
    ReviewDiffNativeStyle(
      rowHeight: rowHeight ?? self.rowHeight,
      contentWidth: contentWidth ?? self.contentWidth,
      changeBarWidth: changeBarWidth,
      gutterWidth: gutterWidth,
      codePadding: codePadding,
      textVerticalInset: textVerticalInset,
      fileHeaderHeight: fileHeaderHeight,
      fileHeaderHorizontalMargin: fileHeaderHorizontalMargin,
      fileHeaderVerticalMargin: fileHeaderVerticalMargin,
      fileHeaderCornerRadius: fileHeaderCornerRadius,
      fileHeaderHorizontalPadding: fileHeaderHorizontalPadding,
      fileHeaderPathRightPadding: fileHeaderPathRightPadding,
      fileHeaderCountColumnWidth: fileHeaderCountColumnWidth,
      fileHeaderCountGap: fileHeaderCountGap,
      codeFontSize: codeFontSize,
      codeFontWeight: codeFontWeight,
      lineNumberFontSize: lineNumberFontSize,
      lineNumberFontWeight: lineNumberFontWeight,
      hunkFontSize: hunkFontSize,
      hunkFontWeight: hunkFontWeight,
      fileHeaderFontSize: fileHeaderFontSize,
      fileHeaderFontWeight: fileHeaderFontWeight,
      fileHeaderMetaFontSize: fileHeaderMetaFontSize,
      fileHeaderMetaFontWeight: fileHeaderMetaFontWeight,
      fileHeaderSubtextFontSize: fileHeaderSubtextFontSize,
      fileHeaderSubtextFontWeight: fileHeaderSubtextFontWeight,
      fileHeaderStatusFontSize: fileHeaderStatusFontSize,
      fileHeaderStatusFontWeight: fileHeaderStatusFontWeight,
      emptyStateFontSize: emptyStateFontSize,
      emptyStateFontWeight: emptyStateFontWeight
    )
  }
}

public final class T3ReviewDiffView: ExpoView, UIScrollViewDelegate {
  private let scrollView = UIScrollView()
  private let contentView = ReviewDiffContentView()
  private var rows: [ReviewDiffNativeRow] = []
  private var appearanceScheme: String = "light"
  private var themePayload: ReviewDiffNativeThemePayload?
  private var stylePayload: ReviewDiffNativeStylePayload?
  private var rowHeightOverride: CGFloat?
  private var contentWidthOverride: CGFloat?
  private var lastMetricsDebugKey = ""
  private var lastVisibleRangeDebugKey = ""
  private var tokensResetKey = ""
  private var initialRowIndex: Int?
  private var hasAppliedInitialRowIndex = false

  let onDebug = EventDispatcher()
  let onToggleFile = EventDispatcher()
  let onToggleViewedFile = EventDispatcher()
  let onPressLine = EventDispatcher()
  let onToggleComment = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    clipsToBounds = true
    backgroundColor = contentView.theme.background
    scrollView.contentInsetAdjustmentBehavior = .never
    scrollView.delegate = self
    scrollView.clipsToBounds = true
    scrollView.alwaysBounceVertical = true
    scrollView.alwaysBounceHorizontal = false
    scrollView.showsVerticalScrollIndicator = true
    scrollView.showsHorizontalScrollIndicator = false
    scrollView.backgroundColor = contentView.theme.background
    addSubview(scrollView)

    contentView.backgroundColor = contentView.theme.background
    contentView.onToggleFile = { [weak self] fileId in
      self?.onToggleFile(["fileId": fileId])
    }
    contentView.onToggleViewedFile = { [weak self] fileId in
      self?.onToggleViewedFile(["fileId": fileId])
    }
    contentView.onPressLine = { [weak self] payload in
      self?.onPressLine(payload)
    }
    contentView.onToggleComment = { [weak self] commentId in
      self?.onToggleComment(["commentId": commentId])
    }
    contentView.onDrawMetrics = { [weak self] metrics in
      self?.emitDebug("draw-metrics", metrics)
    }
    scrollView.addSubview(contentView)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    scrollView.frame = bounds
    updateContentMetrics()
  }

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    if scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating {
      contentView.isVerticalScrollActive = true
    }
    updateViewportFrame()
  }

  public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    guard !decelerate else {
      return
    }

    finishVerticalScroll()
  }

  public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    finishVerticalScroll()
  }

  public func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    finishVerticalScroll()
  }

  func setRowsJson(_ rowsJson: String) {
    guard let data = rowsJson.data(using: .utf8) else {
      return
    }

    do {
      rows = try JSONDecoder().decode([ReviewDiffNativeRow].self, from: data)
      contentView.rows = rows
      hasAppliedInitialRowIndex = false
      emitDebug("rows-decoded", [
        "rows": rows.count,
        "firstKind": rows.first?.kind ?? "none",
      ])
      updateContentMetrics()
    } catch {
      rows = []
      contentView.rows = []
      hasAppliedInitialRowIndex = false
      updateContentMetrics()
      emitDebug("rows-decode-failed", [
        "error": error.localizedDescription,
      ])
    }
  }

  func setTokensJson(_ tokensJson: String) {
    guard let data = tokensJson.data(using: .utf8) else {
      return
    }

    do {
      contentView.tokensByRowId = try JSONDecoder().decode(
        [String: [ReviewDiffNativeToken]].self,
        from: data
      )
    } catch {
      contentView.tokensByRowId = [:]
      emitDebug("tokens-decode-failed", [
        "error": error.localizedDescription,
      ])
    }
  }

  func setTokensPatchJson(_ tokensPatchJson: String) {
    guard let data = tokensPatchJson.data(using: .utf8) else {
      return
    }

    do {
      let patch = try JSONDecoder().decode(ReviewDiffNativeTokenPatch.self, from: data)
      if let resetKey = patch.resetKey, resetKey != tokensResetKey {
        tokensResetKey = resetKey
        contentView.tokensByRowId = [:]
      }

      let tokensByRowId = patch.tokensByRowId ?? [:]
      if tokensByRowId.isEmpty {
        return
      }

      contentView.mergeTokensByRowId(tokensByRowId)
      if let chunkIndex = patch.chunkIndex, chunkIndex < 5 || chunkIndex.isMultiple(of: 10) {
        emitDebug("tokens-patch-decoded", [
          "chunkIndex": chunkIndex,
          "rows": tokensByRowId.count,
          "totalRows": contentView.tokensByRowId.count,
        ])
      }
    } catch {
      emitDebug("tokens-patch-decode-failed", [
        "error": error.localizedDescription,
      ])
    }
  }

  func setTokensResetKey(_ tokensResetKey: String) {
    guard tokensResetKey != self.tokensResetKey else {
      return
    }

    self.tokensResetKey = tokensResetKey
    contentView.tokensByRowId = [:]
    emitDebug("tokens-reset", [
      "resetKey": tokensResetKey,
    ])
  }

  func setCollapsedFileIdsJson(_ collapsedFileIdsJson: String) {
    let nextCollapsedFileIds = decodeFileIdSet(collapsedFileIdsJson)
    let changedFileIds = contentView.collapsedFileIds.symmetricDifference(nextCollapsedFileIds)
    let scrollAnchor: ReviewDiffScrollAnchor?
    if changedFileIds.count == 1, let changedFileId = changedFileIds.first {
      scrollAnchor = contentView.scrollAnchor(forFileId: changedFileId)
    } else {
      scrollAnchor = nil
    }

    contentView.collapsedFileIds = nextCollapsedFileIds
    updateContentMetrics()

    if let scrollAnchor,
       let headerOffset = contentView.fileHeaderOffset(forFileId: scrollAnchor.fileId) {
      let targetOffset = headerOffset - scrollAnchor.screenY
      let maxOffset = max(scrollView.contentSize.height - scrollView.bounds.height, 0)
      let clampedOffset = min(max(targetOffset, 0), maxOffset)
      scrollView.setContentOffset(CGPoint(x: 0, y: clampedOffset), animated: false)
      updateViewportFrame()
    }
  }

  func setViewedFileIdsJson(_ viewedFileIdsJson: String) {
    contentView.viewedFileIds = decodeFileIdSet(viewedFileIdsJson)
  }

  func setSelectedRowIdsJson(_ selectedRowIdsJson: String) {
    contentView.selectedRowIds = decodeFileIdSet(selectedRowIdsJson)
  }

  func setCollapsedCommentIdsJson(_ collapsedCommentIdsJson: String) {
    contentView.collapsedCommentIds = decodeFileIdSet(collapsedCommentIdsJson)
    updateContentMetrics()
  }

  private func decodeFileIdSet(_ json: String) -> Set<String> {
    guard let data = json.data(using: .utf8) else {
      return []
    }

    do {
      return Set(try JSONDecoder().decode([String].self, from: data))
    } catch {
      emitDebug("file-id-set-decode-failed", [
        "error": error.localizedDescription,
      ])
      return []
    }
  }

  func setAppearanceScheme(_ appearanceScheme: String) {
    self.appearanceScheme = appearanceScheme
    applyTheme()
  }

  func setThemeJson(_ themeJson: String) {
    guard let data = themeJson.data(using: .utf8) else {
      themePayload = nil
      applyTheme()
      return
    }

    do {
      themePayload = try JSONDecoder().decode(ReviewDiffNativeThemePayload.self, from: data)
    } catch {
      themePayload = nil
      emitDebug("theme-decode-failed", [
        "error": error.localizedDescription,
      ])
    }

    applyTheme()
  }

  private func updateContentMetrics() {
    let style = contentView.style
    let height = max(bounds.height, contentView.contentHeight)
    let width = bounds.width
    scrollView.contentSize = CGSize(width: bounds.width, height: height)
    contentView.frame = CGRect(
      x: 0,
      y: scrollView.contentOffset.y,
      width: max(width, 1),
      height: max(bounds.height, 1)
    )
    contentView.viewportWidth = bounds.width
    contentView.verticalOffset = scrollView.contentOffset.y
    contentView.invalidateVisibleViewport()
    contentView.setNeedsDisplay()
    applyInitialRowIndexIfNeeded()

    let debugKey = "\(rows.count):\(Int(bounds.width)):\(Int(bounds.height)):\(Int(height))"
    if debugKey != lastMetricsDebugKey {
      lastMetricsDebugKey = debugKey
      emitDebug("metrics", [
        "rows": rows.count,
        "boundsWidth": Double(bounds.width),
        "boundsHeight": Double(bounds.height),
        "contentHeight": Double(height),
        "contentWidth": Double(style.contentWidth),
        "fileHeaderHeight": Double(style.fileHeaderHeight),
        "rowHeight": Double(style.rowHeight),
      ])
    }
  }

  private func emitDebug(_ message: String, _ details: [String: Any]) {
    var payload = details
    payload["message"] = message
    onDebug(payload)
  }

  private func finishVerticalScroll() {
    contentView.isVerticalScrollActive = false
    updateViewportFrame()
    emitVisibleRange(reason: "scroll-end")
  }

  private func emitVisibleRange(reason: String) {
    guard let range = contentView.currentVisibleRowRange() else {
      return
    }

    let debugKey = "\(range.firstRowIndex):\(range.lastRowIndex):\(Int(scrollView.bounds.height))"
    guard debugKey != lastVisibleRangeDebugKey else {
      return
    }

    lastVisibleRangeDebugKey = debugKey
    emitDebug("visible-range", [
      "reason": reason,
      "firstRowIndex": range.firstRowIndex,
      "lastRowIndex": range.lastRowIndex,
      "totalRows": rows.count,
    ])
  }

  private func applyTheme() {
    contentView.theme = ReviewDiffNativeTheme.resolve(appearanceScheme, payload: themePayload)
    backgroundColor = contentView.theme.background
    scrollView.backgroundColor = contentView.theme.background
    contentView.backgroundColor = contentView.theme.background
    contentView.invalidateVisibleViewport()
  }

  func setStyleJson(_ styleJson: String) {
    guard let data = styleJson.data(using: .utf8) else {
      stylePayload = nil
      applyStyle()
      return
    }

    do {
      stylePayload = try JSONDecoder().decode(ReviewDiffNativeStylePayload.self, from: data)
    } catch {
      stylePayload = nil
      emitDebug("style-decode-failed", [
        "error": error.localizedDescription,
      ])
    }

    applyStyle()
  }

  func setRowHeight(_ rowHeight: CGFloat) {
    rowHeightOverride = rowHeight.isFinite && rowHeight > 0 ? rowHeight : nil
    applyStyle()
  }

  func setContentWidth(_ contentWidth: CGFloat) {
    contentWidthOverride = contentWidth.isFinite && contentWidth > 0 ? contentWidth : nil
    applyStyle()
  }

  func setInitialRowIndex(_ initialRowIndex: Double) {
    let nextIndex: Int? = initialRowIndex.isFinite && initialRowIndex >= 0
      ? Int(initialRowIndex.rounded(.down))
      : nil
    guard nextIndex != self.initialRowIndex else {
      return
    }

    self.initialRowIndex = nextIndex
    hasAppliedInitialRowIndex = false
    applyInitialRowIndexIfNeeded()
  }

  private func applyStyle() {
    contentView.style = ReviewDiffNativeStyle
      .resolve(stylePayload)
      .applyingOverrides(rowHeight: rowHeightOverride, contentWidth: contentWidthOverride)
    updateContentMetrics()
  }

  private func updateViewportFrame() {
    contentView.frame = CGRect(
      x: 0,
      y: scrollView.contentOffset.y,
      width: max(bounds.width, 1),
      height: max(bounds.height, 1)
    )
    contentView.verticalOffset = scrollView.contentOffset.y
    contentView.invalidateVisibleViewport()
  }

  private func applyInitialRowIndexIfNeeded() {
    guard !hasAppliedInitialRowIndex,
          let initialRowIndex,
          bounds.height > 0,
          let rowFrame = contentView.frameForRow(at: initialRowIndex) else {
      return
    }

    let targetScreenY = max(0, (bounds.height - rowFrame.height) * 0.3)
    let maxOffset = max(scrollView.contentSize.height - scrollView.bounds.height, 0)
    let targetOffset = min(max(rowFrame.minY - targetScreenY, 0), maxOffset)
    hasAppliedInitialRowIndex = true
    scrollView.setContentOffset(CGPoint(x: 0, y: targetOffset), animated: false)
    updateViewportFrame()
  }
}

private enum ReviewDiffHorizontalPanKind {
  case code
  case fileHeaderPath
}

private struct ReviewDiffFileHeaderPathLayout {
  let displayPath: String
  let rect: CGRect
}

private struct ReviewDiffFileHeaderInteractiveRects {
  let chevron: CGRect
  let icon: CGRect
  let checkbox: CGRect
}

private struct ReviewDiffStickyFileHeaderIndex {
  let position: Int
  let rowIndex: Int
}

private struct ReviewDiffStickyFileHeaderTarget {
  let rowIndex: Int
  let row: ReviewDiffNativeRow
  let rect: CGRect
}

private struct ReviewDiffScrollAnchor {
  let fileId: String
  let screenY: CGFloat
}

private final class ReviewDiffContentView: UIView, UIGestureRecognizerDelegate {
  var rows: [ReviewDiffNativeRow] = [] {
    didSet {
      stopHorizontalDeceleration()
      horizontalOffsetsByFileId.removeAll()
      headerPathOffsetsByFileId.removeAll()
      activePanFileId = nil
      activePanKind = nil
      tokenAttributedStringsByRowId.removeAll()
      rebuildRowLayout()
      setNeedsDisplayForVisibleBounds()
    }
  }
  var tokensByRowId: [String: [ReviewDiffNativeToken]] = [:] {
    didSet {
      tokenAttributedStringsByRowId.removeAll()
      clampHorizontalOffsets()
      setNeedsDisplayForVisibleBounds()
    }
  }

  func mergeTokensByRowId(_ tokensPatch: [String: [ReviewDiffNativeToken]]) {
    tokensPatch.forEach { rowId, tokens in
      tokensByRowId[rowId] = tokens
      tokenAttributedStringsByRowId.removeValue(forKey: rowId)
    }
    clampHorizontalOffsets()
    setNeedsDisplayForVisibleBounds()
  }

  var collapsedFileIds: Set<String> = [] {
    didSet {
      rebuildRowLayout()
      clampHorizontalOffsets()
      setNeedsDisplayForVisibleBounds()
    }
  }
  var viewedFileIds: Set<String> = [] {
    didSet {
      setNeedsDisplayForVisibleBounds()
    }
  }
  var selectedRowIds: Set<String> = [] {
    didSet {
      setNeedsDisplayForVisibleBounds()
    }
  }
  var collapsedCommentIds: Set<String> = [] {
    didSet {
      rebuildRowLayout()
      setNeedsDisplayForVisibleBounds()
    }
  }
  var style = ReviewDiffNativeStyle.resolve(nil) {
    didSet {
      tokenAttributedStringsByRowId.removeAll()
      rebuildRowLayout()
      clampHorizontalOffsets()
      setNeedsDisplayForVisibleBounds()
    }
  }
  var viewportWidth: CGFloat = 0 {
    didSet {
      clampHorizontalOffsets()
      setNeedsDisplayForVisibleBounds()
    }
  }
  var verticalOffset: CGFloat = 0
  var theme = ReviewDiffNativeTheme.resolve("light") {
    didSet {
      tokenColorsByHex.removeAll()
      tokenAttributedStringsByRowId.removeAll()
      setNeedsDisplayForVisibleBounds()
    }
  }
  private(set) var contentHeight: CGFloat = 0

  private var rowOffsets: [CGFloat] = []
  private var fileHeaderRowIndices: [Int] = []
  private var contentWidthsByFileId: [String: CGFloat] = [:]
  private var tokenColorsByHex: [String: UIColor] = [:]
  private var tokenAttributedStringsByRowId: [String: NSAttributedString] = [:]
  private var codeCharacterWidth: CGFloat = 8
  private var panStartHorizontalOffset: CGFloat = 0
  private var activePanFileId: String?
  private var activePanKind: ReviewDiffHorizontalPanKind?
  private var horizontalOffsetsByFileId: [String: CGFloat] = [:]
  private var headerPathOffsetsByFileId: [String: CGFloat] = [:]
  private var decelerationDisplayLink: CADisplayLink?
  private var deceleratingFileId: String?
  private var horizontalVelocity: CGFloat = 0
  private var lastDecelerationTimestamp: CFTimeInterval = 0
  private var lastDrawMetricsTimestamp: CFTimeInterval = 0
  var isVerticalScrollActive = false
  var onToggleFile: ((String) -> Void)?
  var onToggleViewedFile: ((String) -> Void)?
  var onPressLine: (([String: Any]) -> Void)?
  var onToggleComment: ((String) -> Void)?
  var onDrawMetrics: (([String: Any]) -> Void)?

  private var stickyWidth: CGFloat {
    style.changeBarWidth + style.gutterWidth
  }

  private var codeStartX: CGFloat {
    stickyWidth + style.codePadding
  }

  private func height(for row: ReviewDiffNativeRow) -> CGFloat {
    if row.kind == "file" {
      return style.fileHeaderHeight
    }
    if collapsedFileIds.contains(resolvedFileId(for: row)) {
      return 0
    }
    if row.kind == "notice" {
      return max(style.rowHeight * 2, 44)
    }
    if row.kind == "comment" {
      return collapsedCommentIds.contains(row.id) ? 44 : 124
    }
    return style.rowHeight
  }

  func frameForRow(at index: Int) -> CGRect? {
    guard rows.indices.contains(index), rowOffsets.indices.contains(index) else {
      return nil
    }

    return CGRect(
      x: 0,
      y: rowOffsets[index],
      width: max(viewportWidth, 1),
      height: height(for: rows[index])
    )
  }

  private func rebuildRowLayout() {
    var nextOffsets: [CGFloat] = []
    var nextFileHeaderRowIndices: [Int] = []
    nextOffsets.reserveCapacity(rows.count)
    var maxColumnCountsByFileId: [String: Int] = [:]
    var offset: CGFloat = 0

    for (index, row) in rows.enumerated() {
      nextOffsets.append(offset)
      if row.kind == "file" {
        nextFileHeaderRowIndices.append(index)
      }
      offset += height(for: row)

      let fileId = resolvedFileId(for: row)
      switch row.kind {
      case "line":
        maxColumnCountsByFileId[fileId] = max(
          maxColumnCountsByFileId[fileId] ?? 0,
          row.content?.count ?? 0
        )
      case "hunk":
        maxColumnCountsByFileId[fileId] = max(
          maxColumnCountsByFileId[fileId] ?? 0,
          row.text?.count ?? 0
        )
      default:
        continue
      }
    }

    let characterWidth = monospaceCharacterWidth(font: codeFont)
    codeCharacterWidth = characterWidth
    contentWidthsByFileId = maxColumnCountsByFileId.mapValues { maxColumnCount in
      let measuredWidth = ceil(CGFloat(maxColumnCount) * characterWidth) + style.codePadding * 2
      return max(0, min(style.contentWidth, measuredWidth))
    }
    rowOffsets = nextOffsets
    fileHeaderRowIndices = nextFileHeaderRowIndices
    contentHeight = offset
  }

  private var codeFont: UIFont {
    UIFont.monospacedSystemFont(ofSize: style.codeFontSize, weight: style.codeFontWeight)
  }

  private var lineNumberFont: UIFont {
    UIFont.monospacedSystemFont(ofSize: style.lineNumberFontSize, weight: style.lineNumberFontWeight)
  }

  private var hunkFont: UIFont {
    UIFont.monospacedSystemFont(ofSize: style.hunkFontSize, weight: style.hunkFontWeight)
  }

  private var fileHeaderFont: UIFont {
    UIFont.systemFont(ofSize: style.fileHeaderFontSize, weight: style.fileHeaderFontWeight)
  }

  private var fileHeaderMetaFont: UIFont {
    UIFont.systemFont(ofSize: style.fileHeaderMetaFontSize, weight: style.fileHeaderMetaFontWeight)
  }

  private var fileHeaderSubtextFont: UIFont {
    UIFont.systemFont(ofSize: style.fileHeaderSubtextFontSize, weight: style.fileHeaderSubtextFontWeight)
  }

  private var fileHeaderStatusFont: UIFont {
    UIFont.systemFont(ofSize: style.fileHeaderStatusFontSize, weight: style.fileHeaderStatusFontWeight)
  }

  private var emptyStateFont: UIFont {
    UIFont.systemFont(ofSize: style.emptyStateFontSize, weight: style.emptyStateFontWeight)
  }

  private lazy var horizontalPanGesture: UIPanGestureRecognizer = {
    let gesture = UIPanGestureRecognizer(target: self, action: #selector(handleHorizontalPan(_:)))
    gesture.delegate = self
    gesture.cancelsTouchesInView = false
    return gesture
  }()

  private lazy var tapGesture: UITapGestureRecognizer = {
    let gesture = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
    gesture.delegate = self
    gesture.cancelsTouchesInView = false
    return gesture
  }()

  private lazy var longPressGesture: UILongPressGestureRecognizer = {
    let gesture = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
    gesture.delegate = self
    gesture.cancelsTouchesInView = false
    gesture.minimumPressDuration = 0.28
    return gesture
  }()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = true
    contentMode = .redraw
    addGestureRecognizer(horizontalPanGesture)
    addGestureRecognizer(tapGesture)
    addGestureRecognizer(longPressGesture)
    tapGesture.require(toFail: longPressGesture)
  }

  func invalidateVisibleViewport() {
    setNeedsDisplayForVisibleBounds()
  }

  private func setNeedsDisplayForVisibleBounds() {
    setNeedsDisplay()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    isOpaque = true
    contentMode = .redraw
    addGestureRecognizer(horizontalPanGesture)
    addGestureRecognizer(tapGesture)
    addGestureRecognizer(longPressGesture)
    tapGesture.require(toFail: longPressGesture)
  }

  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard gestureRecognizer === horizontalPanGesture else {
      return true
    }

    let velocity = horizontalPanGesture.velocity(in: self)
    guard abs(velocity.x) > abs(velocity.y) * 1.25 else {
      return false
    }

    guard let panTarget = horizontalPanTarget(at: horizontalPanGesture.location(in: self)) else {
      return false
    }

    let currentOffset = horizontalOffset(for: panTarget.fileId, kind: panTarget.kind)
    if velocity.x > 0 && currentOffset <= 0.5 {
      return false
    }

    return maxHorizontalOffset(for: panTarget) > 0
  }

  @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
    guard gesture.state == .ended else {
      return
    }

    let point = gesture.location(in: self)
    if let stickyHeader = stickyFileHeaderTarget(), stickyHeader.rect.contains(point) {
      handleFileHeaderTap(row: stickyHeader.row, rect: stickyHeader.rect, point: point)
      return
    }

    guard let rowIndex = rowIndex(at: verticalOffset + point.y),
          rows.indices.contains(rowIndex) else {
      return
    }

    let row = rows[rowIndex]
    if row.kind == "comment" {
      onToggleComment?(row.id)
      return
    }

    if row.kind == "line" {
      onPressLine?(linePressPayload(for: row, gesture: "tap"))
      return
    }

    guard row.kind == "file" else {
      return
    }

    let rowY = rowOffsets[rowIndex] - verticalOffset
    let rect = CGRect(x: 0, y: rowY, width: max(bounds.width, viewportWidth), height: height(for: row))
    handleFileHeaderTap(row: row, rect: rect, point: point)
  }

  @objc private func handleLongPress(_ gesture: UILongPressGestureRecognizer) {
    guard gesture.state == .began else {
      return
    }

    let point = gesture.location(in: self)
    if let stickyHeader = stickyFileHeaderTarget(), stickyHeader.rect.contains(point) {
      return
    }

    guard let rowIndex = rowIndex(at: verticalOffset + point.y),
          rows.indices.contains(rowIndex) else {
      return
    }

    let row = rows[rowIndex]
    guard row.kind == "line" else {
      return
    }

    onPressLine?(linePressPayload(for: row, gesture: "longPress"))
  }

  private func linePressPayload(for row: ReviewDiffNativeRow, gesture: String) -> [String: Any] {
    var payload: [String: Any] = [
      "rowId": row.id,
      "fileId": resolvedFileId(for: row),
      "gesture": gesture
    ]

    if let oldLineNumber = row.oldLineNumber {
      payload["oldLineNumber"] = oldLineNumber
    }
    if let newLineNumber = row.newLineNumber {
      payload["newLineNumber"] = newLineNumber
    }
    if let change = row.change {
      payload["change"] = change
    }

    return payload
  }

  private func handleFileHeaderTap(row: ReviewDiffNativeRow, rect: CGRect, point: CGPoint) {
    let interactiveRects = fileHeaderInteractiveRects(for: row, cardRect: rect)
    let fileId = resolvedFileId(for: row)

    if interactiveRects.checkbox.contains(point) {
      onToggleViewedFile?(fileId)
      return
    }

    if rect.contains(point) {
      onToggleFile?(fileId)
    }
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    false
  }

  @objc private func handleHorizontalPan(_ gesture: UIPanGestureRecognizer) {
    switch gesture.state {
    case .began:
      stopHorizontalDeceleration()
      let panTarget = horizontalPanTarget(at: gesture.location(in: self))
      activePanFileId = panTarget?.fileId
      activePanKind = panTarget?.kind
      panStartHorizontalOffset = horizontalOffset(for: panTarget?.fileId, kind: panTarget?.kind)
    case .changed, .ended, .cancelled:
      guard let activePanFileId, let activePanKind else {
        return
      }
      let translation = gesture.translation(in: self)
      setHorizontalOffset(
        min(
          max(panStartHorizontalOffset - translation.x, 0),
          maxHorizontalOffset(for: (fileId: activePanFileId, kind: activePanKind))
        ),
        for: activePanFileId,
        kind: activePanKind
      )
      if gesture.state == .ended, activePanKind == .code {
        let velocity = -gesture.velocity(in: self).x
        self.activePanFileId = nil
        self.activePanKind = nil
        startHorizontalDeceleration(fileId: activePanFileId, velocity: velocity)
      } else if gesture.state == .cancelled {
        self.activePanFileId = nil
        self.activePanKind = nil
      } else if gesture.state == .ended {
        self.activePanFileId = nil
        self.activePanKind = nil
      }
    default:
      break
    }
  }

  private func horizontalPanTarget(at point: CGPoint) -> (fileId: String, kind: ReviewDiffHorizontalPanKind)? {
    if let stickyHeader = stickyFileHeaderTarget(), stickyHeader.rect.contains(point) {
      return (resolvedFileId(for: stickyHeader.row), .fileHeaderPath)
    }

    guard let row = row(at: point) else {
      return nil
    }

    let fileId = resolvedFileId(for: row)
    if row.kind == "file" {
      return (fileId, .fileHeaderPath)
    }

    return (fileId, .code)
  }

  private func stickyFileHeaderTarget() -> ReviewDiffStickyFileHeaderTarget? {
    guard let stickyHeader = stickyFileHeaderRowIndex() else {
      return nil
    }

    let rowIndex = stickyHeader.rowIndex
    let headerTop = rowOffsets[rowIndex]
    guard headerTop < verticalOffset else {
      return nil
    }

    let nextHeaderPosition = stickyHeader.position + 1
    let nextHeaderRowIndex = fileHeaderRowIndices.indices.contains(nextHeaderPosition)
      ? fileHeaderRowIndices[nextHeaderPosition]
      : nil
    let pushedY: CGFloat
    if let nextHeaderRowIndex {
      pushedY = min(0, rowOffsets[nextHeaderRowIndex] - verticalOffset - style.fileHeaderHeight)
    } else {
      pushedY = 0
    }

    guard pushedY > -style.fileHeaderHeight else {
      return nil
    }

    let rect = CGRect(
      x: 0,
      y: pushedY,
      width: max(bounds.width, viewportWidth),
      height: style.fileHeaderHeight
    )
    return ReviewDiffStickyFileHeaderTarget(rowIndex: rowIndex, row: rows[rowIndex], rect: rect)
  }

  private func stickyFileHeaderRowIndex() -> ReviewDiffStickyFileHeaderIndex? {
    guard !fileHeaderRowIndices.isEmpty else {
      return nil
    }

    var lowerBound = 0
    var upperBound = fileHeaderRowIndices.count
    while lowerBound < upperBound {
      let midpoint = (lowerBound + upperBound) / 2
      let rowIndex = fileHeaderRowIndices[midpoint]
      if rowOffsets[rowIndex] <= verticalOffset {
        lowerBound = midpoint + 1
      } else {
        upperBound = midpoint
      }
    }

    let matchIndex = lowerBound - 1
    guard matchIndex >= 0 else {
      return nil
    }
    return ReviewDiffStickyFileHeaderIndex(position: matchIndex, rowIndex: fileHeaderRowIndices[matchIndex])
  }

  func scrollAnchor(forFileId fileId: String) -> ReviewDiffScrollAnchor? {
    if let stickyHeader = stickyFileHeaderTarget(),
       resolvedFileId(for: stickyHeader.row) == fileId {
      return ReviewDiffScrollAnchor(fileId: fileId, screenY: 0)
    }

    guard let headerOffset = fileHeaderOffset(forFileId: fileId) else {
      return nil
    }

    return ReviewDiffScrollAnchor(fileId: fileId, screenY: headerOffset - verticalOffset)
  }

  func fileHeaderOffset(forFileId fileId: String) -> CGFloat? {
    guard let rowIndex = fileHeaderRowIndex(forFileId: fileId) else {
      return nil
    }

    return rowOffsets[rowIndex]
  }

  private func fileHeaderRowIndex(forFileId fileId: String) -> Int? {
    fileHeaderRowIndices.first { rowIndex in
      rows.indices.contains(rowIndex) && resolvedFileId(for: rows[rowIndex]) == fileId
    }
  }

  private func row(at point: CGPoint) -> ReviewDiffNativeRow? {
    guard let rowIndex = rowIndex(at: verticalOffset + point.y) else {
      return nil
    }
    guard rows.indices.contains(rowIndex) else {
      return nil
    }
    return rows[rowIndex]
  }

  private func rowIndex(at absoluteY: CGFloat) -> Int? {
    guard !rows.isEmpty else {
      return nil
    }

    var lowerBound = 0
    var upperBound = rows.count - 1
    while lowerBound <= upperBound {
      let midpoint = (lowerBound + upperBound) / 2
      let rowStart = rowOffsets[midpoint]
      let rowEnd = rowStart + height(for: rows[midpoint])

      if absoluteY < rowStart {
        upperBound = midpoint - 1
      } else if absoluteY >= rowEnd {
        lowerBound = midpoint + 1
      } else {
        return midpoint
      }
    }

    return nil
  }

  private func firstVisibleRowIndex(atOrAfter absoluteY: CGFloat) -> Int? {
    guard !rows.isEmpty else {
      return nil
    }

    var lowerBound = 0
    var upperBound = rows.count
    while lowerBound < upperBound {
      let midpoint = (lowerBound + upperBound) / 2
      let rowEnd = rowOffsets[midpoint] + height(for: rows[midpoint])

      if rowEnd < absoluteY {
        lowerBound = midpoint + 1
      } else {
        upperBound = midpoint
      }
    }

    return lowerBound < rows.count ? lowerBound : nil
  }

  private func lastVisibleRowIndex(atOrBefore absoluteY: CGFloat) -> Int? {
    guard !rows.isEmpty else {
      return nil
    }

    var lowerBound = 0
    var upperBound = rows.count
    while lowerBound < upperBound {
      let midpoint = (lowerBound + upperBound) / 2
      let rowStart = rowOffsets[midpoint]

      if rowStart <= absoluteY {
        lowerBound = midpoint + 1
      } else {
        upperBound = midpoint
      }
    }

    let index = lowerBound - 1
    return index >= 0 ? index : nil
  }

  private func resolvedFileId(for row: ReviewDiffNativeRow) -> String {
    if let fileId = row.fileId {
      return fileId
    }
    if let range = row.id.range(of: ":header") ?? row.id.range(of: ":hunk:") ?? row.id.range(of: ":line:") {
      return String(row.id[..<range.lowerBound])
    }
    return row.filePath ?? row.id
  }

  private func horizontalOffset(
    for fileId: String?,
    kind: ReviewDiffHorizontalPanKind? = .code
  ) -> CGFloat {
    guard let fileId else {
      return 0
    }
    if kind == .fileHeaderPath {
      return headerPathOffsetsByFileId[fileId] ?? 0
    }
    return horizontalOffsetsByFileId[fileId] ?? 0
  }

  private func setHorizontalOffset(
    _ offset: CGFloat,
    for fileId: String,
    kind: ReviewDiffHorizontalPanKind = .code
  ) {
    if kind == .fileHeaderPath {
      headerPathOffsetsByFileId[fileId] = offset
      setNeedsDisplayForVisibleBounds()
      return
    }
    horizontalOffsetsByFileId[fileId] = offset
    setNeedsDisplayForVisibleBounds()
  }

  private func clampHorizontalOffsets() {
    for (fileId, offset) in horizontalOffsetsByFileId {
      horizontalOffsetsByFileId[fileId] = min(offset, maxHorizontalOffset(for: (fileId: fileId, kind: .code)))
    }
    for (fileId, offset) in headerPathOffsetsByFileId {
      headerPathOffsetsByFileId[fileId] = min(
        offset,
        maxHorizontalOffset(for: (fileId: fileId, kind: .fileHeaderPath))
      )
    }
  }

  private func maxHorizontalOffset(for target: (fileId: String, kind: ReviewDiffHorizontalPanKind)) -> CGFloat {
    if target.kind == .fileHeaderPath,
       let row = rows.first(where: { resolvedFileId(for: $0) == target.fileId && $0.kind == "file" }) {
      return maxHeaderPathOffset(for: row)
    }

    return max(0, contentWidth(for: target.fileId) - max(0, viewportWidth - codeStartX))
  }

  private func contentWidth(for fileId: String) -> CGFloat {
    contentWidthsByFileId[fileId] ?? min(style.contentWidth, max(viewportWidth, 0))
  }

  func currentVisibleRowRange() -> (firstRowIndex: Int, lastRowIndex: Int)? {
    guard !rows.isEmpty else {
      return nil
    }

    let visibleMinY = verticalOffset
    let visibleMaxY = verticalOffset + max(bounds.height, 1)
    guard let firstRowIndex = firstVisibleRowIndex(atOrAfter: visibleMinY),
          let lastRowIndex = lastVisibleRowIndex(atOrBefore: visibleMaxY),
          firstRowIndex <= lastRowIndex else {
      return nil
    }

    return (firstRowIndex: firstRowIndex, lastRowIndex: lastRowIndex)
  }

  private func maxHeaderPathOffset(for row: ReviewDiffNativeRow) -> CGFloat {
    let fullRect = CGRect(x: 0, y: 0, width: max(bounds.width, viewportWidth), height: height(for: row))
    let layout = fileHeaderPathLayout(for: row, cardRect: fullRect)
    let pathWidth = textWidth(layout.displayPath, font: fileHeaderFont)
    return max(0, pathWidth - layout.rect.width)
  }

  private func startHorizontalDeceleration(fileId: String, velocity: CGFloat) {
    guard abs(velocity) > 80 else {
      return
    }

    let currentOffset = horizontalOffset(for: fileId)
    let maxOffset = maxHorizontalOffset(for: (fileId: fileId, kind: .code))
    if (currentOffset <= 0 && velocity < 0) || (currentOffset >= maxOffset && velocity > 0) {
      return
    }

    stopHorizontalDeceleration()
    deceleratingFileId = fileId
    horizontalVelocity = velocity
    lastDecelerationTimestamp = 0

    let displayLink = CADisplayLink(target: self, selector: #selector(stepHorizontalDeceleration(_:)))
    displayLink.add(to: .main, forMode: .common)
    decelerationDisplayLink = displayLink
  }

  @objc private func stepHorizontalDeceleration(_ displayLink: CADisplayLink) {
    guard let fileId = deceleratingFileId else {
      stopHorizontalDeceleration()
      return
    }

    if lastDecelerationTimestamp == 0 {
      lastDecelerationTimestamp = displayLink.timestamp
      return
    }

    let dt = max(0, displayLink.timestamp - lastDecelerationTimestamp)
    lastDecelerationTimestamp = displayLink.timestamp

    let maxOffset = maxHorizontalOffset(for: (fileId: fileId, kind: .code))
    let nextOffset = horizontalOffset(for: fileId) + horizontalVelocity * CGFloat(dt)
    let clampedOffset = min(max(nextOffset, 0), maxOffset)
    setHorizontalOffset(clampedOffset, for: fileId)

    // UIScrollView deceleration rates are expressed per millisecond.
    horizontalVelocity *= CGFloat(pow(Double(UIScrollView.DecelerationRate.normal.rawValue), dt * 1000))

    if abs(horizontalVelocity) < 20 || clampedOffset <= 0 || clampedOffset >= maxOffset {
      stopHorizontalDeceleration()
    }
  }

  private func stopHorizontalDeceleration() {
    decelerationDisplayLink?.invalidate()
    decelerationDisplayLink = nil
    deceleratingFileId = nil
    horizontalVelocity = 0
    lastDecelerationTimestamp = 0
  }

  deinit {
    stopHorizontalDeceleration()
  }

  override func draw(_ rect: CGRect) {
    let drawStartedAt = CACurrentMediaTime()
    guard let context = UIGraphicsGetCurrentContext() else {
      return
    }

    theme.background.setFill()
    context.fill(rect)

    if rows.isEmpty {
      drawEmptyState(rect)
      return
    }

    let visibleMinY = verticalOffset + rect.minY
    let visibleMaxY = verticalOffset + rect.maxY
    let overscan = max(style.rowHeight, style.fileHeaderHeight) * 4
    let rangeMinY = max(0, visibleMinY - overscan)
    let rangeMaxY = visibleMaxY + overscan
    guard let firstRowIndex = firstVisibleRowIndex(atOrAfter: rangeMinY),
          let lastRowIndex = lastVisibleRowIndex(atOrBefore: rangeMaxY),
          firstRowIndex <= lastRowIndex else {
      return
    }

    var drawnRowCount = 0
    for rowIndex in firstRowIndex...lastRowIndex {
      let rowStart = rowOffsets[rowIndex]
      let rowHeight = height(for: rows[rowIndex])
      if rowHeight <= 0 {
        continue
      }
      let rowEnd = rowStart + rowHeight
      if rowEnd < visibleMinY || rowStart > visibleMaxY {
        continue
      }
      drawRow(rows[rowIndex], rowIndex: rowIndex, context: context)
      drawnRowCount += 1
    }
    drawStickyFileHeader(context: context)

    maybeEmitDrawMetrics(
      drawnRowCount: drawnRowCount,
      durationMs: (CACurrentMediaTime() - drawStartedAt) * 1000,
      firstRowIndex: firstRowIndex,
      lastRowIndex: lastRowIndex
    )
  }

  private func maybeEmitDrawMetrics(
    drawnRowCount: Int,
    durationMs: Double,
    firstRowIndex: Int,
    lastRowIndex: Int
  ) {
    guard !isVerticalScrollActive else {
      return
    }

    let now = CACurrentMediaTime()
    guard now - lastDrawMetricsTimestamp >= 1 else {
      return
    }

    lastDrawMetricsTimestamp = now
    onDrawMetrics?([
      "drawnRows": drawnRowCount,
      "durationMs": durationMs,
      "firstRowIndex": firstRowIndex,
      "lastRowIndex": lastRowIndex,
      "scannedRows": lastRowIndex - firstRowIndex + 1,
      "totalRows": rows.count,
    ])
  }

  private func drawEmptyState(_ rect: CGRect) {
    let message = "No native diff rows"
    let attributes: [NSAttributedString.Key: Any] = [
      .font: emptyStateFont,
      .foregroundColor: theme.mutedText,
    ]
    message.draw(at: CGPoint(x: 16, y: rect.minY + 16), withAttributes: attributes)
  }

  private func drawRow(_ row: ReviewDiffNativeRow, rowIndex: Int, context: CGContext) {
    let rowY = rowOffsets[rowIndex] - verticalOffset
    let fullRect = CGRect(x: 0, y: rowY, width: max(bounds.width, viewportWidth), height: height(for: row))

    switch row.kind {
    case "file":
      drawFileRow(row, rect: fullRect, context: context)
    case "hunk":
      drawHunkRow(row, rect: fullRect, context: context)
    case "notice":
      drawNoticeRow(row, rect: fullRect, context: context)
    case "comment":
      drawCommentRow(row, rect: fullRect, context: context)
    default:
      drawCodeRow(row, rect: fullRect, context: context)
    }
  }

  private func drawStickyFileHeader(context: CGContext) {
    guard let stickyHeader = stickyFileHeaderTarget() else {
      return
    }

    drawFileRow(stickyHeader.row, rect: stickyHeader.rect, context: context)
  }

  private func drawFileRow(_ row: ReviewDiffNativeRow, rect: CGRect, context: CGContext) {
    theme.background.setFill()
    context.fill(rect)

    let cardRect = rect
    theme.headerBackground.setFill()
    context.fill(cardRect)

    let hairline = 1 / UIScreen.main.scale
    theme.border.setFill()
    context.fill(CGRect(x: cardRect.minX, y: cardRect.maxY - hairline, width: cardRect.width, height: hairline))

    let centerY = cardRect.midY
    let interactiveRects = fileHeaderInteractiveRects(for: row, cardRect: cardRect)
    let fileId = resolvedFileId(for: row)
    drawDisclosureChevron(
      rect: interactiveRects.chevron,
      color: theme.mutedText,
      collapsed: collapsedFileIds.contains(fileId)
    )

    drawFileIcon(rect: interactiveRects.icon, changeType: row.changeType)

    drawViewedCheckbox(rect: interactiveRects.checkbox, checked: viewedFileIds.contains(fileId))

    let deletions = row.deletions ?? 0
    let additions = row.additions ?? 0
    let deleteText = "-\(deletions)"
    let addText = "+\(additions)"
    let deleteWidth = textWidth(deleteText, font: fileHeaderMetaFont)
    let addWidth = textWidth(addText, font: fileHeaderMetaFont)
    let countsGap = min(style.fileHeaderCountGap, 4)
    let countsWidth = deleteWidth + countsGap + addWidth
    let countsX = interactiveRects.checkbox.minX - 10 - countsWidth
    drawSingleLineText(
      deleteText,
      rect: CGRect(x: countsX, y: centerY - 9, width: deleteWidth, height: 18),
      color: theme.deleteText,
      font: fileHeaderMetaFont
    )
    drawSingleLineText(
      addText,
      rect: CGRect(x: countsX + deleteWidth + countsGap, y: centerY - 9, width: addWidth, height: 18),
      color: theme.addText,
      font: fileHeaderMetaFont
    )

    let pathLayout = fileHeaderPathLayout(for: row, cardRect: cardRect)
    let pathOffset = horizontalOffset(for: resolvedFileId(for: row), kind: .fileHeaderPath)
    drawSingleLineText(
      pathLayout.displayPath,
      rect: pathLayout.rect,
      color: theme.text,
      font: fileHeaderFont,
      horizontalOffset: pathOffset
    )
    drawFileHeaderPathScrollFade(row, pathRect: pathLayout.rect, horizontalOffset: pathOffset, context: context)
  }

  private func drawNoticeRow(_ row: ReviewDiffNativeRow, rect: CGRect, context: CGContext) {
    guard !collapsedFileIds.contains(resolvedFileId(for: row)) else {
      return
    }

    theme.background.setFill()
    context.fill(rect)

    let hairline = 1 / UIScreen.main.scale
    theme.border.withAlphaComponent(0.65).setFill()
    context.fill(CGRect(x: 0, y: rect.maxY - hairline, width: rect.width, height: hairline))

    let iconSize: CGFloat = 16
    let iconRect = CGRect(
      x: style.fileHeaderHorizontalPadding + 2,
      y: rect.midY - iconSize / 2,
      width: iconSize,
      height: iconSize
    )
    drawNoticeIcon(rect: iconRect, color: theme.mutedText)

    drawSingleLineText(
      row.text ?? "",
      rect: CGRect(
        x: iconRect.maxX + 10,
        y: rect.midY - fileHeaderSubtextFont.lineHeight / 2,
        width: max(24, viewportWidth - iconRect.maxX - 10 - style.fileHeaderHorizontalPadding),
        height: fileHeaderSubtextFont.lineHeight
      ),
      color: theme.mutedText,
      font: fileHeaderSubtextFont
    )
  }

  private func drawCommentRow(_ row: ReviewDiffNativeRow, rect: CGRect, context: CGContext) {
    guard !collapsedFileIds.contains(resolvedFileId(for: row)) else {
      return
    }

    theme.background.setFill()
    context.fill(rect)

    let isCollapsed = collapsedCommentIds.contains(row.id)
    let cardInset = CGFloat(8)
    let cardRect = rect.insetBy(dx: cardInset, dy: 5)
    let cardPath = UIBezierPath(roundedRect: cardRect, cornerRadius: 10)
    theme.headerBackground.setFill()
    cardPath.fill()
    theme.border.withAlphaComponent(0.85).setStroke()
    cardPath.lineWidth = 1
    cardPath.stroke()

    let chevronRect = CGRect(x: cardRect.minX + 10, y: cardRect.minY + 11, width: 16, height: 16)
    drawDisclosureChevron(rect: chevronRect, color: theme.mutedText, collapsed: isCollapsed)

    let title = "Comment on \(row.commentRangeLabel ?? "line")"
    drawSingleLineText(
      title,
      rect: CGRect(
        x: chevronRect.maxX + 10,
        y: cardRect.minY + 8,
        width: max(24, cardRect.width - chevronRect.maxX - 28),
        height: fileHeaderSubtextFont.lineHeight + 4
      ),
      color: theme.mutedText,
      font: fileHeaderSubtextFont
    )

    guard !isCollapsed else {
      return
    }

    let body = row.commentText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    drawMultilineText(
      body.isEmpty ? "Comment" : body,
      rect: CGRect(
        x: cardRect.minX + 18,
        y: cardRect.minY + 42,
        width: max(24, cardRect.width - 36),
        height: max(20, cardRect.height - 56)
      ),
      color: theme.text,
      font: fileHeaderSubtextFont,
      maximumLineCount: 3
    )
  }

  private func fileHeaderPathLayout(
    for row: ReviewDiffNativeRow,
    cardRect: CGRect
  ) -> ReviewDiffFileHeaderPathLayout {
    let centerY = cardRect.midY
    let interactiveRects = fileHeaderInteractiveRects(for: row, cardRect: cardRect)

    let deletions = row.deletions ?? 0
    let additions = row.additions ?? 0
    let deleteWidth = textWidth("-\(deletions)", font: fileHeaderMetaFont)
    let addWidth = textWidth("+\(additions)", font: fileHeaderMetaFont)
    let countsGap = min(style.fileHeaderCountGap, 4)
    let countsWidth = deleteWidth + countsGap + addWidth
    let countsX = interactiveRects.checkbox.minX - 10 - countsWidth
    let pathX = interactiveRects.icon.maxX + 10
    let pathWidth = max(CGFloat(24), countsX - pathX - 12)
    let displayPath: String
    if let previousPath = row.previousPath, previousPath != row.filePath, let filePath = row.filePath {
      displayPath = "\(previousPath) -> \(filePath)"
    } else {
      displayPath = row.filePath ?? ""
    }

    return ReviewDiffFileHeaderPathLayout(
      displayPath: displayPath,
      rect: CGRect(x: pathX, y: centerY - 10, width: pathWidth, height: 20)
    )
  }

  private func fileHeaderInteractiveRects(
    for row: ReviewDiffNativeRow,
    cardRect: CGRect
  ) -> ReviewDiffFileHeaderInteractiveRects {
    let centerY = cardRect.midY
    let horizontalPadding = style.fileHeaderHorizontalPadding
    let chevronRect = CGRect(x: cardRect.minX + horizontalPadding, y: centerY - 10, width: 20, height: 20)
    let iconRect = CGRect(x: chevronRect.maxX + 8, y: centerY - 10, width: 20, height: 20)
    let checkboxRect = CGRect(x: cardRect.maxX - horizontalPadding - 20, y: centerY - 10, width: 20, height: 20)
    return ReviewDiffFileHeaderInteractiveRects(
      chevron: chevronRect,
      icon: iconRect,
      checkbox: checkboxRect
    )
  }

  private func fileStatusText(_ changeType: String?) -> String {
    switch changeType {
    case "new":
      return "A"
    case "deleted":
      return "D"
    case "renamed":
      return "R"
    default:
      return ""
    }
  }

  private func fileStatusColor(_ changeType: String?) -> UIColor {
    switch changeType {
    case "new":
      return theme.addText
    case "deleted":
      return theme.deleteText
    case "renamed", "rename-pure", "rename-changed":
      return theme.hunkText
    default:
      return theme.hunkText
    }
  }

  private func drawStatusPill(_ text: String, rect: CGRect, color: UIColor, font: UIFont) {
    let path = UIBezierPath(roundedRect: rect, cornerRadius: rect.height / 2)
    color.withAlphaComponent(0.12).setFill()
    path.fill()
    drawCenteredText(text, rect: rect, color: color, font: font)
  }

  private func drawFileIcon(rect: CGRect, changeType: String?) {
    let color = fileStatusColor(changeType)
    let outerPath = UIBezierPath(roundedRect: rect, cornerRadius: 6)
    color.setStroke()
    outerPath.lineWidth = 2
    outerPath.stroke()

    if isRenameChange(changeType) {
      drawRenameChevronIcon(rect: rect.insetBy(dx: 4.5, dy: 5), color: color)
      return
    }

    let dotRect = CGRect(x: rect.midX - 3, y: rect.midY - 3, width: 6, height: 6)
    color.setFill()
    UIBezierPath(ovalIn: dotRect).fill()
  }

  private func isRenameChange(_ changeType: String?) -> Bool {
    changeType == "renamed" || changeType == "rename-pure" || changeType == "rename-changed"
  }

  private func drawDisclosureChevron(rect: CGRect, color: UIColor, collapsed: Bool) {
    guard let context = UIGraphicsGetCurrentContext() else {
      return
    }

    context.saveGState()
    context.setStrokeColor(color.cgColor)
    context.setLineWidth(2)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    if collapsed {
      context.move(to: CGPoint(x: rect.minX + rect.width * 0.40, y: rect.minY + rect.height * 0.28))
      context.addLine(to: CGPoint(x: rect.minX + rect.width * 0.60, y: rect.midY))
      context.addLine(to: CGPoint(x: rect.minX + rect.width * 0.40, y: rect.maxY - rect.height * 0.28))
    } else {
      context.move(to: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.minY + rect.height * 0.42))
      context.addLine(to: CGPoint(x: rect.midX, y: rect.minY + rect.height * 0.62))
      context.addLine(to: CGPoint(x: rect.maxX - rect.width * 0.28, y: rect.minY + rect.height * 0.42))
    }
    context.strokePath()
    context.restoreGState()
  }

  private func drawRenameChevronIcon(rect: CGRect, color: UIColor) {
    guard let context = UIGraphicsGetCurrentContext() else {
      return
    }

    context.saveGState()
    context.setStrokeColor(color.cgColor)
    context.setLineWidth(1.8)
    context.setLineCap(.round)
    context.setLineJoin(.round)

    let chevronWidth = min(rect.width * 0.28, 3.6)
    let chevronHeight = min(rect.height, 8)
    let gap = min(rect.width * 0.18, 2.4)
    let totalWidth = chevronWidth * 2 + gap
    let startX = rect.midX - totalWidth / 2
    let topY = rect.midY - chevronHeight / 2
    let bottomY = rect.midY + chevronHeight / 2

    for x in [startX, startX + chevronWidth + gap] {
      context.move(to: CGPoint(x: x, y: topY))
      context.addLine(to: CGPoint(x: x + chevronWidth, y: rect.midY))
      context.addLine(to: CGPoint(x: x, y: bottomY))
    }

    context.strokePath()
    context.restoreGState()
  }

  private func drawViewedCheckbox(rect: CGRect, checked: Bool) {
    let path = UIBezierPath(roundedRect: rect, cornerRadius: 6)
    if checked {
      theme.hunkText.setFill()
      path.fill()
    }
    (checked ? theme.hunkText : theme.mutedText).setStroke()
    path.lineWidth = 1.8
    path.stroke()

    guard checked, let context = UIGraphicsGetCurrentContext() else {
      return
    }

    context.saveGState()
    context.setStrokeColor(theme.background.cgColor)
    context.setLineWidth(2)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    context.move(to: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.midY))
    context.addLine(to: CGPoint(x: rect.minX + rect.width * 0.44, y: rect.maxY - rect.height * 0.30))
    context.addLine(to: CGPoint(x: rect.maxX - rect.width * 0.25, y: rect.minY + rect.height * 0.30))
    context.strokePath()
    context.restoreGState()
  }

  private func drawNoticeIcon(rect: CGRect, color: UIColor) {
    guard let context = UIGraphicsGetCurrentContext() else {
      return
    }

    context.saveGState()
    context.setStrokeColor(color.cgColor)
    context.setLineWidth(1.7)
    context.setLineCap(.round)
    context.setLineJoin(.round)

    context.strokeEllipse(in: rect.insetBy(dx: 1, dy: 1))
    context.move(to: CGPoint(x: rect.midX, y: rect.minY + rect.height * 0.30))
    context.addLine(to: CGPoint(x: rect.midX, y: rect.minY + rect.height * 0.58))
    context.strokePath()
    color.setFill()
    context.fillEllipse(in: CGRect(x: rect.midX - 1, y: rect.maxY - rect.height * 0.30, width: 2, height: 2))
    context.restoreGState()
  }

  private func drawCenteredText(_ text: String, rect: CGRect, color: UIColor, font: UIFont) {
    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.alignment = .center
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color,
      .paragraphStyle: paragraphStyle,
    ]
    (text as NSString).draw(in: rect, withAttributes: attributes)
  }

  private func drawHunkRow(_ row: ReviewDiffNativeRow, rect: CGRect, context: CGContext) {
    let fileId = resolvedFileId(for: row)
    let horizontalOffset = horizontalOffset(for: fileId)
    let contentWidth = contentWidth(for: fileId)
    theme.hunkBackground.setFill()
    context.fill(rect)

    context.saveGState()
    context.clip(to: CGRect(x: stickyWidth, y: rect.minY, width: max(0, viewportWidth - stickyWidth), height: style.rowHeight))
    drawText(
      row.text ?? "",
      rect: CGRect(
        x: codeStartX - horizontalOffset,
        y: centeredTextY(in: rect, font: hunkFont),
        width: contentWidth,
        height: hunkFont.lineHeight
      ),
      color: theme.hunkText,
      font: hunkFont
    )
    context.restoreGState()
  }

  private func drawCodeRow(_ row: ReviewDiffNativeRow, rect: CGRect, context: CGContext) {
    let fileId = resolvedFileId(for: row)
    let horizontalOffset = horizontalOffset(for: fileId)
    let contentWidth = contentWidth(for: fileId)
    let change = row.change ?? "context"
    rowBackground(for: change).setFill()
    context.fill(rect)

    if change == "add" {
      theme.addBar.setFill()
      context.fill(CGRect(x: 0, y: rect.minY, width: style.changeBarWidth, height: style.rowHeight))
    } else if change == "delete" {
      drawDeleteStripes(
        rect: CGRect(x: 0, y: rect.minY, width: style.changeBarWidth, height: style.rowHeight),
        context: context
      )
    }

    drawSelectionOverlay(row, rect: rect, context: context)

    let lineNumber = row.newLineNumber ?? row.oldLineNumber
    if let lineNumber {
      drawRightAlignedText(
        "\(lineNumber)",
        rect: CGRect(
          x: style.changeBarWidth,
          y: centeredTextY(in: rect, font: lineNumberFont),
          width: style.gutterWidth - style.codePadding,
          height: lineNumberFont.lineHeight
        ),
        color: lineNumberColor(for: change),
        font: lineNumberFont
      )
    }

    context.saveGState()
    context.clip(to: CGRect(x: stickyWidth, y: rect.minY, width: max(0, viewportWidth - stickyWidth), height: style.rowHeight))
    let codeTextRect = CGRect(
      x: codeStartX - horizontalOffset,
      y: centeredTextY(in: rect, font: codeFont),
      width: contentWidth,
      height: codeFont.lineHeight
    )
    drawWordDiffRanges(row, rowRect: rect, context: context, horizontalOffset: horizontalOffset)
    if let tokens = tokensByRowId[row.id], !tokens.isEmpty {
      drawTokenText(
        rowId: row.id,
        tokens,
        rect: codeTextRect,
        fallbackColor: theme.text,
        font: codeFont
      )
    } else {
      drawText(row.content ?? "", rect: codeTextRect, color: theme.text, font: codeFont)
    }
    context.restoreGState()
  }

  private func drawSelectionOverlay(
    _ row: ReviewDiffNativeRow,
    rect: CGRect,
    context: CGContext
  ) {
    guard selectedRowIds.contains(row.id) else {
      return
    }

    let selectionColor = theme.hunkText.withAlphaComponent(0.22)
    selectionColor.setFill()
    context.fill(rect)

    theme.hunkText.withAlphaComponent(0.95).setFill()
    context.fill(CGRect(x: 0, y: rect.minY, width: style.changeBarWidth, height: rect.height))
  }

  private func drawWordDiffRanges(
    _ row: ReviewDiffNativeRow,
    rowRect: CGRect,
    context: CGContext,
    horizontalOffset: CGFloat
  ) {
    guard let ranges = row.wordDiffRanges, !ranges.isEmpty else {
      return
    }

    let change = row.change ?? "context"
    guard change == "add" || change == "delete" else {
      return
    }

    let fillColor: UIColor
    if change == "add" {
      fillColor = theme.addBar.withAlphaComponent(0.28)
    } else {
      fillColor = theme.deleteBar.withAlphaComponent(0.28)
    }
    let highlightHeight = max(4, min(rowRect.height - 4, codeFont.lineHeight))
    let highlightY = rowRect.midY - highlightHeight / 2

    fillColor.setFill()
    for range in ranges {
      guard range.end > range.start else {
        continue
      }

      let startX = codeStartX - horizontalOffset + CGFloat(range.start) * codeCharacterWidth
      let width = max(2, CGFloat(range.end - range.start) * codeCharacterWidth)
      let highlightRect = CGRect(
        x: startX,
        y: highlightY,
        width: width,
        height: highlightHeight
      )
      UIBezierPath(roundedRect: highlightRect, cornerRadius: 3).fill()
    }
  }

  private func rowBackground(for change: String) -> UIColor {
    if change == "add" {
      return theme.addBackground
    }
    if change == "delete" {
      return theme.deleteBackground
    }
    return theme.background
  }

  private func lineNumberColor(for change: String) -> UIColor {
    if change == "add" {
      return theme.addText
    }
    if change == "delete" {
      return theme.deleteText
    }
    return theme.mutedText
  }

  private func drawDeleteStripes(rect: CGRect, context: CGContext) {
    theme.deleteBar.setFill()
    var y = rect.minY
    while y < rect.maxY {
      context.fill(CGRect(x: rect.minX, y: y, width: rect.width, height: 1))
      y += 2
    }
  }

  private func drawText(_ text: String, rect: CGRect, color: UIColor, font: UIFont) {
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color,
      .ligature: 0,
    ]
    (text as NSString).draw(in: rect, withAttributes: attributes)
  }

  private func drawMultilineText(
    _ text: String,
    rect: CGRect,
    color: UIColor,
    font: UIFont,
    maximumLineCount: Int
  ) {
    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.lineBreakMode = .byTruncatingTail
    paragraphStyle.lineSpacing = 2

    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color,
      .paragraphStyle: paragraphStyle,
      .ligature: 0,
    ]
    let maxHeight = CGFloat(maximumLineCount) * (font.lineHeight + paragraphStyle.lineSpacing)
    (text as NSString).draw(
      in: CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: min(rect.height, maxHeight)),
      withAttributes: attributes
    )
  }

  private func centeredTextY(in rect: CGRect, font: UIFont) -> CGFloat {
    rect.midY - font.lineHeight / 2
  }

  private func drawSingleLineText(
    _ text: String,
    rect: CGRect,
    color: UIColor,
    font: UIFont,
    horizontalOffset: CGFloat = 0
  ) {
    guard let context = UIGraphicsGetCurrentContext() else {
      return
    }

    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color,
      .ligature: 0,
    ]
    context.saveGState()
    context.clip(to: rect)
    let textY = rect.midY - font.lineHeight / 2
    (text as NSString).draw(
      at: CGPoint(x: rect.minX - horizontalOffset, y: textY),
      withAttributes: attributes
    )
    context.restoreGState()
  }

  private func drawFileHeaderPathScrollFade(
    _ row: ReviewDiffNativeRow,
    pathRect: CGRect,
    horizontalOffset: CGFloat,
    context: CGContext
  ) {
    let maxOffset = maxHeaderPathOffset(for: row)
    guard maxOffset > 0, pathRect.width > 0 else {
      return
    }

    let fadeWidth = min(CGFloat(28), pathRect.width / 3)
    if horizontalOffset > 0.5 {
      drawHorizontalFade(
        rect: CGRect(x: pathRect.minX, y: pathRect.minY, width: fadeWidth, height: pathRect.height),
        color: theme.headerBackground,
        fadesToRight: false,
        context: context
      )
    }

    if horizontalOffset < maxOffset - 0.5 {
      drawHorizontalFade(
        rect: CGRect(x: pathRect.maxX - fadeWidth, y: pathRect.minY, width: fadeWidth, height: pathRect.height),
        color: theme.headerBackground,
        fadesToRight: true,
        context: context
      )
    }
  }

  private func drawHorizontalFade(
    rect: CGRect,
    color: UIColor,
    fadesToRight: Bool,
    context: CGContext
  ) {
    guard rect.width > 0,
          let gradient = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(),
            colors: [
              color.withAlphaComponent(fadesToRight ? 0 : 1).cgColor,
              color.withAlphaComponent(fadesToRight ? 1 : 0).cgColor,
            ] as CFArray,
            locations: [0, 1]
          ) else {
      return
    }

    context.saveGState()
    context.clip(to: rect)
    context.drawLinearGradient(
      gradient,
      start: CGPoint(x: rect.minX, y: rect.midY),
      end: CGPoint(x: rect.maxX, y: rect.midY),
      options: []
    )
    context.restoreGState()
  }

  private func textWidth(_ text: String, font: UIFont) -> CGFloat {
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .ligature: 0]
    return ceil((text as NSString).size(withAttributes: attributes).width)
  }

  private func monospaceCharacterWidth(font: UIFont) -> CGFloat {
    let sampleLength = 64
    let sample = String(repeating: "M", count: sampleLength)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .ligature: 0]
    return (sample as NSString).size(withAttributes: attributes).width / CGFloat(sampleLength)
  }

  private func drawTokenText(
    rowId: String,
    _ tokens: [ReviewDiffNativeToken],
    rect: CGRect,
    fallbackColor: UIColor,
    font: UIFont
  ) {
    let attributedText = tokenAttributedString(
      rowId: rowId,
      tokens: tokens,
      fallbackColor: fallbackColor,
      font: font
    )
    attributedText.draw(in: rect)
  }

  private func tokenAttributedString(
    rowId: String,
    tokens: [ReviewDiffNativeToken],
    fallbackColor: UIColor,
    font: UIFont
  ) -> NSAttributedString {
    if let cached = tokenAttributedStringsByRowId[rowId] {
      return cached
    }

    let attributedString = NSMutableAttributedString(string: "")
    for token in tokens where !token.content.isEmpty {
      attributedString.append(
        NSAttributedString(
          string: token.content,
          attributes: [
            .font: font,
            .foregroundColor: tokenColor(for: token.color, fallbackColor: fallbackColor),
            .ligature: 0,
          ]
        )
      )
    }

    tokenAttributedStringsByRowId[rowId] = attributedString
    return attributedString
  }

  private func tokenColor(for hex: String?, fallbackColor: UIColor) -> UIColor {
    guard let hex, !hex.isEmpty else {
      return fallbackColor
    }

    if let color = tokenColorsByHex[hex] {
      return color
    }

    guard let color = UIColor(reviewDiffHex: hex) else {
      return fallbackColor
    }

    tokenColorsByHex[hex] = color
    return color
  }

  private func drawRightAlignedText(_ text: String, rect: CGRect, color: UIColor, font: UIFont) {
    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.alignment = .right
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color,
      .paragraphStyle: paragraphStyle,
    ]
    (text as NSString).draw(in: rect, withAttributes: attributes)
  }
}

private extension UIColor {
  convenience init?(reviewDiffHex hex: String?) {
    guard var value = hex?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
      return nil
    }

    if value.hasPrefix("#") {
      value.removeFirst()
    }

    guard value.count == 6 || value.count == 8 else {
      return nil
    }

    var rawValue: UInt64 = 0
    guard Scanner(string: value).scanHexInt64(&rawValue) else {
      return nil
    }

    let red: CGFloat
    let green: CGFloat
    let blue: CGFloat
    let alpha: CGFloat

    if value.count == 8 {
      red = CGFloat((rawValue >> 24) & 0xff) / 255
      green = CGFloat((rawValue >> 16) & 0xff) / 255
      blue = CGFloat((rawValue >> 8) & 0xff) / 255
      alpha = CGFloat(rawValue & 0xff) / 255
    } else {
      red = CGFloat((rawValue >> 16) & 0xff) / 255
      green = CGFloat((rawValue >> 8) & 0xff) / 255
      blue = CGFloat(rawValue & 0xff) / 255
      alpha = 1
    }

    self.init(red: red, green: green, blue: blue, alpha: alpha)
  }
}
