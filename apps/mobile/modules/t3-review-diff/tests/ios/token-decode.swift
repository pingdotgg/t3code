// Instrument decoder entry and accepted publication in the real serial queue.
private final class TokenDecodeProbe {
  private let lock = NSLock()
  private var entries = 0
  private var publications = 0
  private var onEntry: ((Int) -> Void)?

  func reset(onEntry: ((Int) -> Void)? = nil) {
    lock.lock()
    entries = 0
    publications = 0
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

  func publish() {
    lock.lock()
    publications += 1
    lock.unlock()
  }

  func checkCounts(_ expectedEntries: Int, _ expectedPublications: Int, _ name: String) {
    lock.lock()
    defer { lock.unlock() }
    check(entries == expectedEntries,
          "\(name): expected \(expectedEntries) token decoder entries, got \(entries)")
    check(publications == expectedPublications,
          "\(name): expected \(expectedPublications) retained full publications, got \(publications)")
    print("Passed tokens: \(name), decoder entries=\(entries), retained full publications=\(publications)")
  }
}

private let tokenDecodeProbe = TokenDecodeProbe()

private func decodeTokensForTest(
  _ type: [String: [ReviewDiffNativeToken]].Type, from data: Data
) throws -> [String: [ReviewDiffNativeToken]] {
  tokenDecodeProbe.enter()
  return try JSONDecoder().decode(type, from: data)
}

private func tokenPayload(_ id: String) -> String {
  "{\"\(id)\":[{\"content\":\"漢字 👨‍👩‍👧‍👦 é\",\"color\":\"#ff0000\",\"fontStyle\":3},{\"content\":\"tail\",\"fontStyle\":0}]}"
}

private func tokenPatch(_ id: String, key: String = "tokens", chunk: Int = 0) -> String {
  "{\"resetKey\":\"\(key)\",\"chunkIndex\":\(chunk),\"tokensByRowId\":\(tokenPayload(id))}"
}

private extension T3ReviewDiffView {
  static func afterTokens(on queue: DispatchQueue, _ completion: @escaping () -> Void) {
    queue.async { DispatchQueue.main.async(execute: completion) }
  }

  func checkTokens(_ payloads: [String]) {
    var expected: [String: [ReviewDiffNativeToken]] = [:]
    for payload in payloads {
      let decoded = try! JSONDecoder().decode([String: [ReviewDiffNativeToken]].self, from: Data(payload.utf8))
      expected.merge(decoded) { _, next in next }
    }
    let describe = { (value: [String: [ReviewDiffNativeToken]]) in
      value.mapValues { $0.map { String(reflecting: $0) } }
    }
    check(describe(contentView.tokensByRowId) == describe(expected), "Token fields/output order changed")
  }

  static func runQueuedTokenDecodeCase(_ index: Int) {
    let names = ["A B C burst", "content reset", "reset then B", "same content key",
                 "token reset preserves full", "same token key", "current full", "current malformed",
                 "obsolete malformed", "full patch full", "full then patches", "patches then full",
                 "additive patches", "reset rejects old patch"]
    guard index < names.count else { runReleasedTokenDecodeCase(); return }
    tokenDecodeProbe.reset()
    let view = T3ReviewDiffView()
    view.setContentResetKey("content")
    view.setTokensResetKey("tokens")
    var errors: [String] = []
    view.onDebug.onEvent = { payload in
      if payload["message"] as? String == "tokens-decode-failed" {
        errors.append(payload["error"] as! String)
      }
    }
    view.contentView.tokensByRowId = try! JSONDecoder().decode(
      [String: [ReviewDiffNativeToken]].self, from: Data(tokenPayload("seed").utf8)
    )
    var acknowledgements: [Bool] = []
    let patch = { (id: String, chunk: Int) in
      view.setTokensPatchJson(tokenPatch(id, chunk: chunk)) { acknowledgements.append($0) }
    }
    view.payloadDecodeQueue.suspend()
    switch index {
    case 0:
      for id in ["a", "b", "c"] { view.setTokensJson(tokenPayload(id)) }
    case 1, 2:
      view.setTokensJson(tokenPayload("a"))
      view.setContentResetKey("new")
      if index == 2 { view.setTokensJson(tokenPayload("b")) }
    case 3:
      view.setTokensJson(tokenPayload("b"))
      view.setContentResetKey("content")
    case 4, 5:
      view.setTokensJson(tokenPayload("b"))
      view.setTokensResetKey(index == 4 ? "new" : "tokens")
    case 6: view.setTokensJson(tokenPayload("b"))
    case 7: view.setTokensJson("invalid JSON")
    case 8:
      view.setTokensJson("invalid JSON")
      view.setTokensJson(tokenPayload("b"))
    case 9:
      view.setTokensJson(tokenPayload("a"))
      patch("patch", 0)
      view.setTokensJson(tokenPayload("b"))
    case 10:
      view.setTokensJson(tokenPayload("b"))
      patch("one", 0)
      patch("two", 1)
    case 11:
      patch("one", 0)
      patch("two", 1)
      view.setTokensJson(tokenPayload("b"))
    case 12:
      patch("one", 0)
      patch("two", 1)
    default:
      patch("old", 0)
      view.setContentResetKey("new")
      view.setTokensJson(tokenPayload("b"))
    }
    view.payloadDecodeQueue.resume()
    afterTokens(on: view.payloadDecodeQueue) {
      let entries = index == 1 || index == 12 ? 0 : 1
      let publications = entries
      tokenDecodeProbe.checkCounts(entries, publications, names[index])
      if index == 1 || index == 7 {
        view.checkTokens([])
      } else if index == 0 {
        view.checkTokens([tokenPayload("c")])
      } else if index == 10 {
        view.checkTokens([tokenPayload("b"), tokenPayload("one"), tokenPayload("two")])
      } else if index == 12 {
        view.checkTokens([tokenPayload("seed"), tokenPayload("one"), tokenPayload("two")])
      } else {
        view.checkTokens([tokenPayload("b")])
      }
      check(acknowledgements == (index == 9 ? [true] : index == 10 || index == 11 || index == 12 ? [true, true] : index == 13 ? [false] : []),
            "All additive chunks must retain their acknowledgement semantics")
      if index == 7 {
        do {
          _ = try JSONDecoder().decode([String: [ReviewDiffNativeToken]].self, from: Data("invalid JSON".utf8))
        } catch { check(errors == [error.localizedDescription], "Current error/fallback changed") }
      } else { check(errors.isEmpty, "Obsolete errors must not publish") }
      runQueuedTokenDecodeCase(index + 1)
    }
  }

  static func runReleasedTokenDecodeCase() {
    tokenDecodeProbe.reset()
    var view: T3ReviewDiffView? = T3ReviewDiffView()
    let queue = view!.payloadDecodeQueue
    let released = { [weak view] in view == nil }
    queue.suspend()
    view!.setTokensJson(tokenPayload("released"))
    view = nil
    check(released(), "Queued token closure must not retain the view")
    queue.resume()
    afterTokens(on: queue) {
      tokenDecodeProbe.checkCounts(0, 0, "release before entry")
      runEnteredTokenDecodeCase(invalid: false)
    }
  }

  static func runEnteredTokenDecodeCase(invalid: Bool) {
    let view = T3ReviewDiffView()
    let release = DispatchSemaphore(value: 0)
    tokenDecodeProbe.reset { entry in
      guard entry == 1 else { return }
      DispatchQueue.main.async {
        view.setContentResetKey("new")
        view.setTokensJson(tokenPayload("b"))
        release.signal()
        afterTokens(on: view.payloadDecodeQueue) {
          tokenDecodeProbe.checkCounts(2, 1, "entered \(invalid ? "error" : "success") then replacement")
          view.checkTokens([tokenPayload("b")])
          tokenDecodeProbe.reset()
          if invalid { runReleasedEnteredTokenDecodeCase() } else { runEnteredTokenDecodeCase(invalid: true) }
        }
      }
      release.wait()
    }
    view.setTokensJson(invalid ? "invalid JSON" : tokenPayload("a"))
  }

  static func runReleasedEnteredTokenDecodeCase() {
    var view: T3ReviewDiffView? = T3ReviewDiffView()
    let released = { [weak view] in view == nil }
    let queue = view!.payloadDecodeQueue
    let release = DispatchSemaphore(value: 0)
    tokenDecodeProbe.reset { _ in
      DispatchQueue.main.async {
        view = nil
        check(released(), "Entered decoder must not keep the view alive")
        release.signal()
        afterTokens(on: queue) {
          tokenDecodeProbe.checkCounts(1, 0, "release after entry")
          tokenDecodeProbe.reset()
          exit(0)
        }
      }
      release.wait()
    }
    view!.setTokensJson(tokenPayload("a"))
  }
}
