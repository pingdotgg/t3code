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

// The runner instruments the production resolver in its temporary compile input only.
private enum HeaderLookupReads {
  static var enabled = false
  static var headers = 0
  static var code = 0
  static func record(_ row: ReviewDiffNativeRow) {
    guard enabled else { return }
    if row.kind == "file" { headers += 1 } else { code += 1 }
  }
}

private extension ReviewDiffContentView {
  func checkHeaderPathLimits() throws {
    viewportWidth = 390
    let longPath = String(repeating: "long/directory/", count: 12)
    func decode(_ input: [[String: Any]]) throws -> [ReviewDiffNativeRow] {
      try JSONDecoder().decode([ReviewDiffNativeRow].self, from: JSONSerialization.data(withJSONObject: input))
    }
    var fixture: [[String: Any]] = []
    for file in 0..<10 {
      fixture.append(["kind": "file", "id": "f\(file):header", "fileId": "f\(file)",
                      "filePath": longPath + "new-\(file).swift", "previousPath": "old-\(file).swift",
                      "additions": file + 1, "deletions": file * 2])
      for line in 0..<100 {
        fixture.append(["kind": "line", "id": "f\(file):line:\(line)", "fileId": "f\(file)",
                        "content": String(repeating: "code ", count: 100)])
      }
    }
    // A code row sharing the target ID must not hide the first header.
    fixture.insert(["kind": "line", "id": "impostor", "fileId": "f9", "content": "value"], at: 0)
    fixture += [
      ["kind": "file", "id": "duplicate:header", "fileId": "f9", "filePath": "short.swift"],
      ["kind": "file", "id": "empty:header", "fileId": "", "filePath": longPath + "empty.swift"],
      ["kind": "file", "id": "derived:header", "filePath": longPath + "derived.swift"],
      ["kind": "file", "id": "path-fallback", "filePath": longPath + "fallback.swift"],
      ["kind": "file", "id": "id-only"],
      ["kind": "line", "id": "orphan:line:0", "fileId": "orphan", "content": String(repeating: "code ", count: 100)]
    ]
    let input = try decode(fixture)
    rows = input
    for wrap in [false, true] {
      style = try geometryStyle(wrap: wrap)
      func verify(_ label: String) {
        for (caseIndex, id) in ["f0", "f5", "f9", "", "derived", longPath + "fallback.swift", "id-only", "orphan", "missing"].enumerated() {
          let header = rows.first { $0.kind == "file" && $0.resolvedFileId == id }
          let expected = header.map { maxHeaderPathOffset(for: $0) }
            ?? maxHorizontalOffset(for: (fileId: id, kind: .code))
          let actual = maxHorizontalOffset(for: (fileId: id, kind: .fileHeaderPath))
          print("HEADER_LIMIT iOS wrap=\(wrap) state=\(label) case=\(caseIndex) limit=\(actual)")
          check(actual == expected, "\(label) wrap=\(wrap) id=\(id): header path limit changed")
          if ["f0", "f5", "f9", "", "derived"].contains(id) {
            check(actual > 0, "Long rename/header path must overflow in either wrap mode")
          }
          // This is the same clamp called after token, style, and viewport changes.
          setHorizontalOffset(.greatestFiniteMagnitude, for: id, kind: .fileHeaderPath)
          clampHorizontalOffsets()
          check(horizontalOffset(for: id, kind: .fileHeaderPath) == expected, "Header clamp changed")
          setHorizontalOffset(13, for: id, kind: .code)
          clampHorizontalOffsets()
          check(horizontalOffset(for: id, kind: .code) == min(13, maxHorizontalOffset(for: (id, .code))),
                "Code bounds changed")
        }
      }
      verify("expanded")
      collapsedFileIds = ["f0", "f5"]
      verify("collapsed")
      collapsedFileIds = []
      verify("reexpanded")
    }
    // Known fixture: ten headers separated by 100 code rows; repeatedly clamp the last.
    rows = try decode(Array(fixture[1..<1011]))
    style = try geometryStyle(wrap: false)
    headerPathOffsetsByFileId = ["f9": 1]
    horizontalOffsetsByFileId = [:]
    HeaderLookupReads.headers = 0
    HeaderLookupReads.code = 0
    HeaderLookupReads.enabled = true
    for _ in 0..<120 { clampHorizontalOffsets() }
    HeaderLookupReads.enabled = false
    print("HEADER_LOOKUP iOS updates=120 headerVisits=\(HeaderLookupReads.headers) codeVisits=\(HeaderLookupReads.code)")
    // Finish semantic checks before rejecting baseline scan work.
    rows = try decode([["kind": "file", "id": "replacement:header", "fileId": "f9", "filePath": "short.swift"]])
    check(headerPathOffsetsByFileId.isEmpty && horizontalOffsetsByFileId.isEmpty, "Replacement clears offsets")
    check(maxHorizontalOffset(for: ("f9", .fileHeaderPath)) == 0, "Replacement must use current header")
    rows = []
    check(fileHeaderRowIndices.isEmpty && headerPathOffsetsByFileId.isEmpty, "Reset must clear old index/offsets")
    check(maxHorizontalOffset(for: ("f9", .fileHeaderPath)) == maxHorizontalOffset(for: ("f9", .code)),
          "Missing-header fallback after reset changed")
    print("Passed iOS header limits: first/middle/last, duplicate, empty/absent IDs, rename, collapse/reexpand, replacement/reset, wrap and code bounds")
    check(HeaderLookupReads.code == 0, "Header clamps must not inspect code rows")
    check(HeaderLookupReads.headers == 1200, "Header clamps must visit only preceding headers")
  }
}
try ReviewDiffContentView(frame: CGRect(x: 0, y: 0, width: 390, height: 600)).checkHeaderPathLimits()

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
