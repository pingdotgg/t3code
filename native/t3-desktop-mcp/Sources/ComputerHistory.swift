import AppKit
import ApplicationServices
import Foundation

/// Background Computer History recorder (Skysight-style).
///
/// Invoked as `t3-desktop-mcp computer-history --root <dir>`.
/// Writes interaction events under `<root>/segments/` and status to
/// `<root>/status.json`. Honors `<root>/control.json` for pause/filters.
enum ComputerHistoryDaemon {
  static func run(root: String) {
    let rootURL = URL(fileURLWithPath: root, isDirectory: true)
    try? FileManager.default.createDirectory(
      at: rootURL.appendingPathComponent("segments"), withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(
      at: rootURL.appendingPathComponent("memories/resources"), withIntermediateDirectories: true)

    let state = DaemonState(root: rootURL)
    state.writeStatus()

    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)

    let center = NSWorkspace.shared.notificationCenter
    center.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { note in
      guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      else { return }
      state.recordAppChange(app)
    }

    // Poll focused AX element + control file. CGEventTap would add click/key
    // fidelity but requires the same Accessibility trust we already need.
    Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
      state.tick()
    }

    state.sessionStarted()
    fputs("t3-desktop-mcp: computer-history daemon started root=\(root)\n", stderr)
    NSApp.run()
  }
}

private final class DaemonState {
  let root: URL
  let sessionID: String
  private var segmentID: String
  private var segmentStartedAt: Date
  private var eventCount = 0
  private var suppressed = 0
  private var lastAppKey: String?
  private var lastFocusKey: String?
  private var paused = false
  private var enabled = false
  private var appFilterMode = "exclude"
  private var apps: [String] = []
  private var websiteFilterMode = "exclude"
  private var websites: [String] = []
  private var eventsHandle: FileHandle?
  private let iso = ISO8601DateFormatter()

  init(root: URL) {
    self.root = root
    self.sessionID = UUID().uuidString
    let now = Date()
    self.segmentStartedAt = now
    self.segmentID = Self.segmentName(for: now)
    self.iso.formatOptions = [.withInternetDateTime]
    openSegment()
    reloadControl()
  }

  private static func segmentName(for date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    let stamp = f.string(from: date).replacingOccurrences(of: ":", with: "-")
    // Unique suffix so concurrent/restarted daemons never share a segment dir.
    return "\(stamp)-\(UUID().uuidString.prefix(8))"
  }

  private var segmentDir: URL {
    root.appendingPathComponent("segments/\(segmentID)", isDirectory: true)
  }

  private func openSegment() {
    let dir = segmentDir
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let eventsURL = dir.appendingPathComponent("events.jsonl")
    if !FileManager.default.fileExists(atPath: eventsURL.path) {
      FileManager.default.createFile(atPath: eventsURL.path, contents: nil)
    }
    eventsHandle = try? FileHandle(forWritingTo: eventsURL)
    _ = try? eventsHandle?.seekToEnd()
    writeMetadata(endedAt: nil, endReason: nil)
  }

  private func writeMetadata(endedAt: Date?, endReason: String?) {
    var payload: [String: Any] = [
      "sessionID": sessionID,
      "segmentID": segmentID,
      "startedAt": iso.string(from: segmentStartedAt),
      "eventCount": eventCount,
      "suppressedEventCount": suppressed,
      "platform": "darwin",
    ]
    if let endedAt { payload["endedAt"] = iso.string(from: endedAt) }
    if let endReason { payload["endReason"] = endReason }
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])) ?? Data()
    try? data.write(to: segmentDir.appendingPathComponent("metadata.json"))
  }

  func writeStatus() {
    let trusted = AXIsProcessTrusted()
    let phase: String
    if !enabled {
      phase = "stopped"
    } else if paused {
      phase = "paused"
    } else if !trusted {
      phase = "error"
    } else {
      phase = "running"
    }
    var payload: [String: Any] = [
      "phase": phase,
      "accessibilityGranted": trusted,
      "activeSegmentId": segmentID,
      "eventCount": eventCount,
      "platform": "darwin",
      "updatedAt": iso.string(from: Date()),
      "pid": ProcessInfo.processInfo.processIdentifier,
    ]
    if !trusted {
      payload["lastError"] =
        "Accessibility permission is not granted to the host app. Enable it in System Settings → Privacy & Security → Accessibility."
    }
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])) ?? Data()
    try? data.write(to: root.appendingPathComponent("status.json"))
  }

  private func reloadControl() {
    let url = root.appendingPathComponent("control.json")
    guard let data = try? Data(contentsOf: url),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return }
    enabled = (json["enabled"] as? Bool) ?? enabled
    paused = (json["paused"] as? Bool) ?? paused
    appFilterMode = (json["appFilterMode"] as? String) ?? appFilterMode
    websiteFilterMode = (json["websiteFilterMode"] as? String) ?? websiteFilterMode
    apps = (json["apps"] as? [String]) ?? apps
    websites = (json["websites"] as? [String]) ?? websites
  }

  private func allowed(app: NSRunningApplication, context: BrowserContext) -> Bool {
    let needles = apps.map { $0.lowercased() }
    let hay = [
      app.bundleIdentifier ?? "",
      app.localizedName ?? "",
      app.bundleURL?.path ?? "",
    ]
    .map { $0.lowercased() }
    .filter { !$0.isEmpty }
    let hit = !needles.isEmpty && needles.contains { needle in
      hay.contains { $0.contains(needle) || needle.contains($0) }
    }
    let appOk: Bool
    if needles.isEmpty {
      appOk = appFilterMode == "exclude"
    } else {
      appOk = appFilterMode == "exclude" ? !hit : hit
    }
    guard appOk else { return false }

    let isBrowser = Self.isBrowser(app)
    let siteNeedles = websites.map { $0.lowercased() }
    if websiteFilterMode == "includeOnly" && siteNeedles.isEmpty {
      return false
    }
    let includeOnly = websiteFilterMode == "includeOnly"

    // Private-mode markers may live in the title even when AXURL is an ordinary https URL.
    if isBrowser,
       let signal = context.privateSignal,
       Self.isPrivateBrowsing(text: signal.lowercased())
    {
      return false
    }
    guard let url = context.url else {
      return !includeOnly
    }
    let lowered = url.lowercased()
    if isBrowser, Self.isPrivateBrowsing(text: lowered) {
      return false
    }
    // Website filters only apply to URL-like haystacks, never plain window titles.
    let looksUrl = lowered.contains("://")
      || lowered.hasPrefix("about:")
      || lowered.hasPrefix("chrome:")
      || lowered.hasPrefix("edge:")
      || lowered.hasPrefix("brave:")
    guard looksUrl else { return !includeOnly }
    if siteNeedles.isEmpty {
      return websiteFilterMode == "exclude"
    }
    let siteHit = siteNeedles.contains { Self.hostMatches(url: lowered, needle: $0) }
    return websiteFilterMode == "exclude" ? !siteHit : siteHit
  }

  private struct BrowserContext {
    var url: String?
    var privateSignal: String?
    var windowTitle: String?
  }

  /// Best-effort browser page URL / private-mode signal from AX + window title.
  private func browserContext(for app: NSRunningApplication) -> BrowserContext {
    var context = BrowserContext()
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    if let focused = chAxElement(ax, kAXFocusedUIElementAttribute as String) {
      var focusedWindow = chAxElement(focused, kAXWindowAttribute as String)
      // Prefer document/window URL over the focused element's AXURL — links
      // expose their target as AXURL and would bypass website privacy filters.
      if let doc = chAxString(focused, "AXDocument"), !doc.isEmpty {
        context.url = doc
      } else if let window = focusedWindow {
        if let doc = chAxString(window, "AXDocument"), !doc.isEmpty {
          context.url = doc
        } else if let url = chAxString(window, "AXURL"), !url.isEmpty {
          context.url = url
        }
      }
      // Window title carries private-browsing chrome; always prefer it over the
      // focused element title (often a link label, not the tab chrome).
      if focusedWindow == nil {
        focusedWindow = chAxElement(focused, kAXWindowAttribute as String)
      }
      if let window = focusedWindow,
         let title = chAxString(window, kAXTitleAttribute as String),
         !title.isEmpty
      {
        context.privateSignal = title
        context.windowTitle = title
      } else if let title = chAxString(focused, kAXTitleAttribute as String), !title.isEmpty {
        context.privateSignal = title
        context.windowTitle = title
      }
    }
    // Only pair a window title as the private-mode signal with the URL taken
    // from that same window — never borrow another window's title.
    if context.url == nil, let windows = chAxCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement] {
      for window in windows.prefix(4) {
        let url = chAxString(window, "AXDocument").flatMap { $0.isEmpty ? nil : $0 }
          ?? chAxString(window, "AXURL").flatMap { $0.isEmpty ? nil : $0 }
        guard let url else { continue }
        context.url = url
        if let title = chAxString(window, kAXTitleAttribute as String), !title.isEmpty {
          context.privateSignal = title
          context.windowTitle = title
        }
        break
      }
    }
    return context
  }

  private static func isBrowser(_ app: NSRunningApplication) -> Bool {
    let hay = [
      app.bundleIdentifier ?? "",
      app.localizedName ?? "",
      app.bundleURL?.path ?? "",
    ]
    .map { $0.lowercased() }
    return ["chrome", "chromium", "firefox", "safari", "edge", "brave", "opera", "arc", "vivaldi"].contains { needle in
      hay.contains { $0.contains(needle) }
    }
  }

  private static func isPrivateBrowsing(text: String) -> Bool {
    text.contains("chrome://private")
      || text.contains("chrome-search://local-ntp")
      || text.hasPrefix("about:privatebrowsing")
      || text.contains("about:privatebrowsing")
      || text.contains("private browsing")
      || text.contains("edge://private")
      || text.contains("brave://private")
      || text.contains("opera://private")
      || text.contains("(private)")
      || text.contains("incognito")
      || text.contains("inprivate")
  }

  private static func hostMatches(url: String, needle: String) -> Bool {
    let needle = needle.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
    guard !needle.isEmpty else { return false }
    if needle.contains("/") || !needle.contains(".") {
      if url.contains(needle) {
        return true
      }
    }
    for host in urlHosts(url) {
      if host == needle || host.hasSuffix(".\(needle)") {
        return true
      }
    }
    return url == needle || url.hasSuffix(".\(needle)")
  }

  private static func urlHosts(_ raw: String) -> [String] {
    var hosts: [String] = []
    var rest = raw
    while let range = rest.range(of: "://") {
      let after = rest[range.upperBound...]
      let end = after.firstIndex(where: { "/?# \n\t".contains($0) }) ?? after.endIndex
      let authority = String(after[..<end])
      let hostPart = authority.split(separator: "@").last.map(String.init) ?? authority
      let host = (hostPart.split(separator: ":").first.map(String.init) ?? hostPart)
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
      if !host.isEmpty {
        hosts.append(host)
      }
      rest = String(after[end...])
    }
    if hosts.isEmpty, let parsed = URL(string: raw), let host = parsed.host?.lowercased(), !host.isEmpty {
      hosts.append(host)
    }
    return hosts
  }

  private static func urlHost(_ raw: String) -> String? {
    urlHosts(raw).first
  }

  @discardableResult
  private func append(_ record: [String: Any]) -> Bool {
    guard let eventsHandle,
          let data = try? JSONSerialization.data(withJSONObject: record),
          var line = String(data: data, encoding: .utf8)
    else { return false }
    line.append("\n")
    guard let bytes = line.data(using: .utf8) else { return false }
    do {
      try eventsHandle.write(contentsOf: bytes)
    } catch {
      // Do not bump counters / rewrite metadata for a line that never landed.
      return false
    }
    eventCount += 1
    writeMetadata(endedAt: nil, endReason: nil)
    return true
  }

  private func rotateIfNeeded() {
    if Date().timeIntervalSince(segmentStartedAt) < 10 * 60 { return }
    writeMetadata(endedAt: Date(), endReason: "max_duration")
    try? eventsHandle?.close()
    eventCount = 0
    suppressed = 0
    segmentStartedAt = Date()
    segmentID = Self.segmentName(for: segmentStartedAt)
    openSegment()
  }

  func sessionStarted() {
    append([
      "id": UUID().uuidString,
      "timestamp": iso.string(from: Date()),
      "kind": "session.started",
      "detail": "computer-history daemon",
    ])
    writeStatus()
  }

  func recordAppChange(_ app: NSRunningApplication) {
    reloadControl()
    writeStatus()
    guard enabled, !paused, AXIsProcessTrusted() else { return }
    let pageContext = browserContext(for: app)
    guard allowed(app: app, context: pageContext) else {
      suppressed += 1
      // Clear so returning to the same allowed app is not treated as a duplicate.
      lastAppKey = nil
      return
    }
    let key = "\(app.processIdentifier):\(app.bundleIdentifier ?? "")"
    guard key != lastAppKey else { return }
    rotateIfNeeded()
    var appPayload: [String: Any] = [
      "processIdentifier": app.processIdentifier,
    ]
    if let bid = app.bundleIdentifier { appPayload["bundleIdentifier"] = bid }
    if let name = app.localizedName { appPayload["name"] = name }
    if let path = app.bundleURL?.path { appPayload["path"] = path }

    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var windowTitle = pageContext.windowTitle
    if windowTitle == nil,
       let windows = chAxCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement],
       let first = windows.first
    {
      windowTitle = chAxString(first, kAXTitleAttribute as String)
    }

    var record: [String: Any] = [
      "id": UUID().uuidString,
      "timestamp": iso.string(from: Date()),
      "kind": "appWindowChanged",
      "app": appPayload,
    ]
    if let windowTitle {
      record["window"] = ["title": windowTitle]
    }
    guard append(record) else { return }
    lastAppKey = key
  }

  func tick() {
    reloadControl()
    rotateIfNeeded()
    writeStatus()
    guard enabled, !paused else { return }
    guard AXIsProcessTrusted() else { return }

    guard let app = NSWorkspace.shared.frontmostApplication else { return }
    let pageContext = browserContext(for: app)
    guard allowed(app: app, context: pageContext) else {
      suppressed += 1
      // Clear so returning to the same allowed control is not treated as a duplicate.
      lastFocusKey = nil
      return
    }

    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    let focused = chAxElement(axApp, kAXFocusedUIElementAttribute as String)
    let role = focused.flatMap { chAxString($0, kAXRoleAttribute as String) }
    let desc = focused.flatMap { chAxString($0, kAXDescriptionAttribute as String) }
      ?? focused.flatMap { chAxString($0, kAXTitleAttribute as String) }
    let value = focused.flatMap { chAxString($0, kAXValueAttribute as String) }
    var windowTitle = pageContext.windowTitle
    if windowTitle == nil,
       let windows = chAxCopy(axApp, kAXWindowsAttribute as String) as? [AXUIElement],
       let first = windows.first
    {
      windowTitle = chAxString(first, kAXTitleAttribute as String)
    }

    let focusKey = "\(app.processIdentifier)|\(windowTitle ?? "")|\(role ?? "")|\(desc ?? "")|\(value?.count ?? 0)|\((value ?? "").prefix(200))"
    guard focusKey != lastFocusKey else { return }

    var appPayload: [String: Any] = ["processIdentifier": app.processIdentifier]
    if let bid = app.bundleIdentifier { appPayload["bundleIdentifier"] = bid }
    if let name = app.localizedName { appPayload["name"] = name }

    var axPayload: [String: Any] = [:]
    if let role { axPayload["role"] = role }
    if let desc { axPayload["description"] = String(desc.prefix(200)) }
    if let value { axPayload["value"] = String(value.prefix(200)) }

    var record: [String: Any] = [
      "id": UUID().uuidString,
      "timestamp": iso.string(from: Date()),
      "kind": "sample.frontmost",
      "app": appPayload,
    ]
    if let windowTitle { record["window"] = ["title": windowTitle] }
    if !axPayload.isEmpty { record["ax"] = axPayload }
    guard append(record) else { return }
    lastFocusKey = focusKey
  }
}

// Prefixed helpers avoid colliding with main.swift's internal AX utilities.
private func chAxCopy(_ el: AXUIElement, _ attr: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success ? value : nil
}

private func chAxString(_ el: AXUIElement, _ attr: String) -> String? {
  chAxCopy(el, attr) as? String
}

private func chAxElement(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
  guard let v = chAxCopy(el, attr), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}
