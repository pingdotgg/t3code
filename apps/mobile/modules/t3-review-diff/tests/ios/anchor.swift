// Exercise the real UIScrollView/geometry update path with a preceding large file.
private extension T3ReviewDiffView {
  func checkRowAnchoring() throws {
    frame = CGRect(x: 0, y: 0, width: 390, height: 600)
    layoutSubviews()
    setContentInsetTop(80)
    let fixture = ["highlights.c", "simd128.h"].flatMap { file in
      [["kind": "file", "id": "\(file):header", "fileId": file]] + (0..<100).map { line in
        ["kind": "line", "id": "\(file):line:\(line)", "fileId": file,
         "content": String(repeating: "long native code ", count: line % 9 + 1)]
      }
    }
    rows = try JSONDecoder().decode([ReviewDiffNativeRow].self, from: JSONSerialization.data(withJSONObject: fixture))
    contentView.rows = rows
    updateContentMetrics()
    let index = 130
    func position(_ intra: CGFloat) {
      setVerticalContentOffset(contentView.frameForRow(at: index)!.minY + intra, animated: false)
    }
    func assertPosition(_ intra: CGFloat, _ reason: String) {
      let frame = contentView.frameForRow(at: index)!
      let top = scrollView.contentOffset.y + scrollView.contentInset.top
      check(top >= frame.minY && top < frame.maxY, "\(reason): visible row/file changed across geometry update")
      check(abs(top - frame.minY - intra) < 0.01, "\(reason): intra-row position changed")
      check(contentView.verticalOffset == scrollView.contentOffset.y, "Viewport and UIScrollView must agree")
    }
    position(7)
    isProgrammaticScrollActive = true
    contentView.isVerticalScrollActive = true
    setStyleJson("{\"wordWrap\":true}")
    assertPosition(7, "wrap on")
    check(!isProgrammaticScrollActive && !contentView.isVerticalScrollActive,
          "Anchor restoration must finish an interrupted programmatic scroll")
    setStyleJson("{\"wordWrap\":true,\"codeFontSize\":22}")
    assertPosition(7, "font change")
    frame.size.width = 280
    layoutSubviews()
    assertPosition(7, "wrapped width change")
    position(contentView.frameForRow(at: index)!.height - 2)
    setStyleJson("{\"wordWrap\":false,\"rowHeight\":24}")
    let height = contentView.frameForRow(at: index)!.height
    assertPosition(height - 1, "unwrap clamps inside shortened row")
    setInitialFileId("simd128.h")
    layoutSubviews()
    check(abs(scrollView.contentOffset.y + scrollView.contentInset.top - contentView.fileHeaderOffset(forFileId: "simd128.h")!) < 0.01,
          "Explicit initial-file navigation must win over geometry anchoring")
    setContentResetKey("new-content")
    setStyleJson("{\"wordWrap\":true}")
    check(rows.isEmpty && scrollView.contentOffset.y == -80, "Reset must discard the old anchor")
    print("Passed viewport row anchors for wrap, font, width, intra-row clamp, initial file, and reset")
  }
}
try T3ReviewDiffView().checkRowAnchoring()
