// Geometry tests exercise the production content view without an Expo app or device.
private extension ReviewDiffContentView {
  func checkSparseGeometry(expectedNativeRows: Int) {
    check(codeLayoutsByRowId.count == expectedNativeRows,
          "Offscreen ASCII must not retain per-row layout objects or wrap-start arrays (retained \(codeLayoutsByRowId.count))")
  }

  func checkReferenceGeometry() {
    let font = codeFont
    let characterWidth = monospaceCharacterWidth(font: font)
    let width = codeLayoutWidthLimit(font: font)
    var offset: CGFloat = 0
    var widths: [String: CGFloat] = [:]
    for (index, row) in rows.enumerated() {
      check(rowOffsets[index] == offset, "Wrapped offsets changed for \(row.id)")
      var rowHeight = height(for: row)
      if row.kind == "line", let width, let content = row.content {
        let reference = ReviewDiffCodeLayout(text: content, font: font, width: width, characterWidth: characterWidth)
        if rowHeight > 0 {
          rowHeight = max(rowHeight, reference.firstLineHeight) + reference.extraHeight
        }
        widths[row.resolvedFileId] = max(widths[row.resolvedFileId] ?? 0, reference.usedWidth)
      } else if row.kind == "hunk" {
        widths[row.resolvedFileId] = max(widths[row.resolvedFileId] ?? 0, textWidth(row.text ?? "", font: hunkFont))
      }
      check(height(at: index) == rowHeight, "Row height changed for \(row.id)")
      if rowHeight > 0 {
        check(rowIndex(at: offset + rowHeight / 2) == index, "Hit testing must use the published wrapped offsets")
      }
      offset += rowHeight
    }
    check(contentHeight == offset, "Content height must include every row")
    check(contentWidthsByFileId == widths.mapValues { ceil($0) + style.codePadding * 2 },
          "The end of every unwrapped line must remain reachable")
  }

  func preparedOffsetAddress() -> UInt {
    guard let geometry = preparedRowGeometry else { fatalError("Geometry was not prepared") }
    return geometry.offsets.withUnsafeBufferPointer { UInt(bitPattern: $0.baseAddress) }
  }

  func checkPublishedOffsetAddress(_ address: UInt) {
    check(rowOffsets.withUnsafeBufferPointer { UInt(bitPattern: $0.baseAddress) } == address,
          "Publication must reuse the prepared offsets without rebuilding on the UI thread")
  }

  func checkCancellationInsideLoop() {
    var checks = 0
    let input = ReviewDiffRowGeometryInput(
      configuration: geometryConfiguration, font: codeFont, hunkFont: hunkFont,
      characterWidth: codeCharacterWidth, layoutWidth: codeLayoutWidthLimit(font: codeFont), cached: [:]
    )
    let geometry = Self.buildRowGeometry(
      rows, input: input, isCancelled: {
        checks += 1
        return checks == 2
      }
    )
    check(geometry == nil && checks == 2, "Obsolete work must abort at the next batch, before visiting every row")
  }
}

private let geometryRows = try JSONDecoder().decode([ReviewDiffNativeRow].self, from: JSONSerialization.data(withJSONObject:
  [["kind": "file", "id": "a:header", "fileId": "a"],
   ["kind": "hunk", "id": "a:hunk:0", "fileId": "a", "text": "@@ context\twith tabs @@"]] + (0..<4096).map { index in
    ["kind": "line", "id": "a:line:\(index)", "fileId": "a",
     "content": String(repeating: "printable ASCII ", count: index % 30), "newLineNumber": index + 1]
   } + [["kind": "line", "id": "a:unicode", "fileId": "a", "content": "漢字\t👨‍👩‍👧‍👦"],
        ["kind": "comment", "id": "a:comment", "fileId": "a"],
        ["kind": "file", "id": "b:header", "fileId": "b"],
        ["kind": "line", "id": "b:line:0", "fileId": "b", "content": "e\u{301}\tمرحبا"]]
))
private let geometryView = ReviewDiffContentView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
private func geometryStyle(wrap: Bool, fontSize: Int = 12, weight: String = "regular", rowHeight: Int = 24) throws -> ReviewDiffNativeStyle {
  let payload = try JSONDecoder().decode(ReviewDiffNativeStylePayload.self, from: Data(
    "{\"wordWrap\":\(wrap),\"codeFontSize\":\(fontSize),\"codeFontWeight\":\"\(weight)\",\"rowHeight\":\(rowHeight)}".utf8
  ))
  return ReviewDiffNativeStyle.resolve(payload)
}
geometryView.style = try geometryStyle(wrap: true)
geometryView.viewportWidth = 390
geometryView.rows = geometryRows
geometryView.checkSparseGeometry(expectedNativeRows: 2)
geometryView.checkReferenceGeometry()
geometryView.checkCancellationInsideLoop()
for width: CGFloat in [400, 280] {
  geometryView.viewportWidth = width
  geometryView.checkReferenceGeometry()
}
geometryView.collapsedFileIds = ["b"]
geometryView.collapsedCommentIds = ["a:comment"]
geometryView.checkReferenceGeometry()
geometryView.style = try geometryStyle(wrap: true, fontSize: 28, weight: "bold", rowHeight: 8)
geometryView.checkReferenceGeometry()
geometryView.style = try geometryStyle(wrap: false)
geometryView.checkReferenceGeometry()
geometryView.collapsedFileIds = []
geometryView.collapsedCommentIds = []
geometryView.style = try geometryStyle(wrap: true)
geometryView.checkReferenceGeometry()
let originalHeight = geometryView.contentHeight
geometryView.mergeTokensByRowId(["a:line:29": [ReviewDiffNativeToken(content: geometryRows[31].content ?? "", color: "#ff0000", fontStyle: 3)]])
geometryView.selectedRowIds = ["a:line:29"]
check(geometryView.contentHeight == originalHeight, "Tokens and selection must preserve geometry")

// Configuration changes before publication must restart preparation from a fresh snapshot.
private let geometryQueue = DispatchQueue(label: "review-diff.geometry-tests")
geometryQueue.suspend()
geometryView.prepareRows(geometryRows, on: geometryQueue, isCurrent: { true }, completion: {
  let address = geometryView.preparedOffsetAddress()
  geometryView.rows = geometryRows
  geometryView.checkPublishedOffsetAddress(address)
  geometryView.checkSparseGeometry(expectedNativeRows: 2)
  geometryView.checkReferenceGeometry()
  check(geometryView.style.codeFontSize == 28 && geometryView.viewportWidth == 400)

  // A reset/new payload can cancel work before its worker is scheduled, without publishing it.
  geometryQueue.suspend()
  geometryView.prepareRows(geometryRows, on: geometryQueue, isCurrent: { true }, completion: {
    check(false, "Cancelled geometry must never publish")
  })
  geometryView.rows = []
  geometryQueue.resume()
  geometryQueue.async {
    DispatchQueue.main.async {
      check(geometryView.rows.isEmpty && geometryView.contentHeight == 0, "Reset must remain empty after obsolete work drains")
      print("Passed sparse geometry, reference heights/widths, font/wrap/collapse, hit testing, direct publication, and cancellation")
      exit(0)
    }
  }
})
geometryView.style = try geometryStyle(wrap: true, fontSize: 28, weight: "bold", rowHeight: 8)
geometryView.viewportWidth = 400
geometryView.collapsedFileIds = ["b"]
geometryView.collapsedCommentIds = ["a:comment"]
geometryQueue.resume()
dispatchMain()
