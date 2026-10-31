// The harness instruments only decoder entry; scheduling and publication use the real view.
private final class RowDecodeProbe {
  private let lock = NSLock()
  private var entries = 0
  private var onEntry: ((Int) -> Void)?

  func reset(onEntry: ((Int) -> Void)? = nil) {
    lock.lock()
    entries = 0
    self.onEntry = onEntry
    lock.unlock()
  }

  func enter() {
    lock.lock()
    entries += 1
    let entry = entries
    let callback = onEntry
    lock.unlock()
    callback?(entry)
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return entries
  }
}

private let rowDecodeProbe = RowDecodeProbe()

private func decodeRowsForTest(_ data: Data) throws -> [ReviewDiffNativeRow] {
  rowDecodeProbe.enter()
  return try JSONDecoder().decode([ReviewDiffNativeRow].self, from: data)
}

private extension ReviewDiffContentView {
  func checkSameGeometry(as reference: ReviewDiffContentView) {
    check(rowOffsets == reference.rowOffsets && contentHeight == reference.contentHeight,
          "Queued decoding must preserve reference row offsets and height")
    check(contentWidthsByFileId == reference.contentWidthsByFileId,
          "Queued decoding must preserve reference widths")
  }
}

private extension T3ReviewDiffView {
  // One worker/main round decodes, the next prepares and publishes geometry.
  func afterRowPipeline(_ completion: @escaping () -> Void) {
    Self.afterRowPipeline(on: payloadDecodeQueue, completion)
  }

  static func afterRowPipeline(on queue: DispatchQueue, _ completion: @escaping () -> Void) {
    queue.async {
      DispatchQueue.main.async {
        queue.async {
          DispatchQueue.main.async(execute: completion)
        }
      }
    }
  }

  func checkRowsMatch(_ json: String) {
    let expected = try! JSONDecoder().decode([ReviewDiffNativeRow].self, from: Data(json.utf8))
    check(rows.map { String(reflecting: $0) } == expected.map { String(reflecting: $0) },
          "Every decoded row field must match the unchanged decoder")
    check(contentView.rows.map { String(reflecting: $0) } == rows.map { String(reflecting: $0) })
    contentView.checkReferenceGeometry()
    let reference = ReviewDiffContentView(frame: contentView.frame)
    reference.style = contentView.style
    reference.viewportWidth = contentView.viewportWidth
    reference.collapsedFileIds = contentView.collapsedFileIds
    reference.collapsedCommentIds = contentView.collapsedCommentIds
    reference.rows = expected
    contentView.checkSameGeometry(as: reference)
  }

  func checkEmptyRows() {
    check(rows.isEmpty && contentView.rows.isEmpty && contentView.contentHeight == 0,
          "Reset/error must remain empty after the queue drains")
  }
}

private func rowDecodePayload(_ file: String) -> String {
  let objects: [[String: Any]] = [
    ["kind": "file", "id": "\(file):header", "fileId": file, "filePath": "\(file).swift"],
    ["kind": "hunk", "id": "\(file):hunk", "fileId": file, "text": "@@ context\t@@"],
    ["kind": "line", "id": "\(file):ascii", "fileId": file, "content": String(repeating: "let value = 123; ", count: 60),
     "change": "add", "newLineNumber": 1, "wordDiffRanges": [["start": 0, "end": 3]]],
    ["kind": "line", "id": "\(file):unicode", "fileId": file, "content": "漢字\t👨‍👩‍👧‍👦 e\u{301} مرحبا", "oldLineNumber": 2],
    ["kind": "comment", "id": "\(file):comment", "fileId": file, "commentText": "Keep every field"],
  ]
  return String(data: try! JSONSerialization.data(withJSONObject: objects), encoding: .utf8)!
}

private extension T3ReviewDiffView {
  static func runQueuedRowDecodeCase(_ index: Int) {
    let names = ["A to B", "reset", "reset then B", "unchanged reset key", "current success", "current error", "obsolete error"]
    guard index < names.count else {
      runReleasedRowDecodeCase()
      return
    }
    rowDecodeProbe.reset()
    let view = T3ReviewDiffView()
    view.bounds = CGRect(x: 0, y: 0, width: 390, height: 844)
    view.layoutSubviews()
    view.setContentResetKey("section-a")
    view.setStyleJson("{\"wordWrap\":true}")
    view.pendingScrollFileId = "pending"
    var events: [[String: Any]] = []
    view.onDebug.onEvent = { payload in
      if (payload["message"] as? String)?.hasPrefix("rows-decode") == true { events.append(payload) }
    }
    let a = rowDecodePayload("a")
    let b = rowDecodePayload("b")
    view.payloadDecodeQueue.suspend()
    switch index {
    case 0:
      view.setRowsJson(a)
      view.setRowsJson(b)
    case 1, 2:
      view.setRowsJson(a)
      view.setContentResetKey("section-b")
      if index == 2 { view.setRowsJson(b) }
    case 3:
      view.setRowsJson(b)
      view.setContentResetKey("section-a")
    case 4:
      view.setRowsJson(b)
    case 5:
      view.rows = try! JSONDecoder().decode([ReviewDiffNativeRow].self, from: Data(a.utf8))
      view.contentView.rows = view.rows
      view.setRowsJson("invalid JSON")
    default:
      view.setRowsJson("invalid JSON")
      view.setRowsJson(b)
    }
    view.payloadDecodeQueue.resume()
    view.afterRowPipeline {
      let expected = index == 1 ? 0 : 1
      check(rowDecodeProbe.count == expected,
            "\(names[index]): expected \(expected) decoder entries, got \(rowDecodeProbe.count)")
      if index == 1 {
        view.checkEmptyRows()
        check(events.isEmpty, "Reset work must not publish success or error")
      } else if index == 5 {
        view.checkEmptyRows()
        check(view.pendingScrollFileId == nil, "Current error must clear pending scroll")
        check(events.count == 1 && events[0]["message"] as? String == "rows-decode-failed")
        do {
          _ = try JSONDecoder().decode([ReviewDiffNativeRow].self, from: Data("invalid JSON".utf8))
          check(false)
        } catch {
          check(events[0]["error"] as? String == error.localizedDescription, "Preserve the current error")
        }
      } else {
        view.checkRowsMatch(b)
        check(events.count == 1 && events[0]["message"] as? String == "rows-decoded",
              "Only the current payload may publish success")
      }
      print("Passed queued row decode: \(names[index]), decoder entries=\(rowDecodeProbe.count)")
      runQueuedRowDecodeCase(index + 1)
    }
  }

  static func runReleasedRowDecodeCase() {
    rowDecodeProbe.reset()
    var view: T3ReviewDiffView? = T3ReviewDiffView()
    let isReleased = { [weak view] in view == nil }
    let queue = view!.payloadDecodeQueue
    queue.suspend()
    view!.setRowsJson(rowDecodePayload("released"))
    view = nil
    check(isReleased(), "Queued row work must not retain the view")
    queue.resume()
    T3ReviewDiffView.afterRowPipeline(on: queue) {
      check(rowDecodeProbe.count == 0, "Release before worker resume must skip decoding")
      print("Passed release before worker resume, decoder entries=0")
      runRunningRowDecodeCase(invalid: false)
    }
  }

  static func runRunningRowDecodeCase(invalid: Bool) {
    let view = T3ReviewDiffView()
    let release = DispatchSemaphore(value: 0)
    let b = rowDecodePayload("current")
    var publications = 0
    view.onDebug.onEvent = { payload in
      if (payload["message"] as? String)?.hasPrefix("rows-decode") == true {
        check(payload["message"] as? String == "rows-decoded", "Running stale errors must not publish")
        publications += 1
      }
    }
    rowDecodeProbe.reset { entry in
      guard entry == 1 else { return }
      DispatchQueue.main.async {
        view.setContentResetKey("new-section")
        view.setRowsJson(b)
        release.signal()
        view.afterRowPipeline {
          check(rowDecodeProbe.count == 2, "An entered decoder must finish; the current payload must also decode")
          check(publications == 1, "Running obsolete success/error must not publish")
          view.checkRowsMatch(b)
          rowDecodeProbe.reset()
          print("Passed running \(invalid ? "error" : "success") replaced by current rows, decoder entries=2")
          if invalid { runReleasedRunningRowDecodeCase() } else { runRunningRowDecodeCase(invalid: true) }
        }
      }
      release.wait()
    }
    view.setRowsJson(invalid ? "invalid JSON" : rowDecodePayload("running"))
  }

  static func runReleasedRunningRowDecodeCase() {
    var view: T3ReviewDiffView? = T3ReviewDiffView()
    let isReleased = { [weak view] in view == nil }
    let queue = view!.payloadDecodeQueue
    let release = DispatchSemaphore(value: 0)
    var publications = 0
    view!.onDebug.onEvent = { payload in
      if (payload["message"] as? String)?.hasPrefix("rows-decode") == true { publications += 1 }
    }
    rowDecodeProbe.reset { _ in
      DispatchQueue.main.async {
        view = nil
        check(isReleased(), "An entered decoder must not retain the view")
        release.signal()
        afterRowPipeline(on: queue) {
          check(rowDecodeProbe.count == 1 && publications == 0,
                "An entered decode may finish after release but must not publish")
          rowDecodeProbe.reset()
          print("Passed release after decoder entry without retaining the view, decoder entries=1")
          runAdditiveTokenPatchCase()
        }
      }
      release.wait()
    }
    view!.setRowsJson(rowDecodePayload("released-running"))
  }

  static func runAdditiveTokenPatchCase() {
    let view = T3ReviewDiffView()
    view.setTokensResetKey("tokens")
    view.payloadDecodeQueue.suspend()
    var acknowledgements: [Bool] = []
    for id in ["one", "two"] {
      view.setTokensPatchJson("{\"resetKey\":\"tokens\",\"tokensByRowId\":{\"\(id)\":[{\"content\":\"\(id)\"}]}}") {
        acknowledgements.append($0)
      }
    }
    view.payloadDecodeQueue.resume()
    view.afterRowPipeline {
      check(acknowledgements == [true, true], "Every additive token patch must be acknowledged")
      check(Set(view.contentView.tokensByRowId.keys) == Set(["one", "two"]), "Token patches must never coalesce")
      print("Passed additive token patches and acknowledgements; all 12 row/payload lifecycle cases passed")
      exit(0)
    }
  }
}

private func runRowDecodeTests() {
  T3ReviewDiffView.runQueuedRowDecodeCase(0)
}
