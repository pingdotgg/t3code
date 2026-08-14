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
  private var enabled = true
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
    return f.string(from: date).replacingOccurrences(of: ":", with: "-")
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

  private func allowed(app: NSRunningApplication, url: String?) -> Bool {
    let needles = apps.map { $0.lowercased() }
    let hay = [
      app.bundleIdentifier ?? "",
      app.localizedName ?? "",
      app.bundleURL?.path ?? "",
    ].map { $0.lowercased() }
    let hit = needles.contains { needle in
      hay.contains { $0.contains(needle) || needle.contains($0) }
    }
    let appOk: Bool
    if needles.isEmpty {
      appOk = appFilterMode == "exclude"
    } else {
      appOk = appFilterMode == "exclude" ? !hit : hit
    }
    guard appOk else { return false }

    if let url {
      let lowered = url.lowercased()
      if lowered.contains("chrome://newtab") || lowered.hasPrefix("about:privatebrowsing") {
        return false
      }
      let siteNeedles = websites.map { $0.lowercased() }
      if siteNeedles.isEmpty {
        return websiteFilterMode == "exclude"
      }
      let siteHit = siteNeedles.contains { lowered.contains($0) }
      return websiteFilterMode == "exclude" ? !siteHit : siteHit
    }
    return true
  }

  private func append(_ record: [String: Any]) {
    guard let eventsHandle,
          let data = try? JSONSerialization.data(withJSONObject: record),
          var line = String(data: data, encoding: .utf8)
    else { return }
    line.append("\n")
    if let bytes = line.data(using: .utf8) {
      try? eventsHandle.write(contentsOf: bytes)
    }
    eventCount += 1
    writeMetadata(endedAt: nil, endReason: nil)
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
    guard allowed(app: app, url: nil) else {
      suppressed += 1
      return
    }
    let key = "\(app.processIdentifier):\(app.bundleIdentifier ?? "")"
    guard key != lastAppKey else { return }
    lastAppKey = key
    rotateIfNeeded()
    var appPayload: [String: Any] = [
      "processIdentifier": app.processIdentifier,
    ]
    if let bid = app.bundleIdentifier { appPayload["bundleIdentifier"] = bid }
    if let name = app.localizedName { appPayload["name"] = name }
    if let path = app.bundleURL?.path { appPayload["path"] = path }

    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var windowTitle: String?
    if let windows = chAxCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement],
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
    append(record)
  }

  func tick() {
    reloadControl()
    rotateIfNeeded()
    writeStatus()
    guard enabled, !paused else { return }
    guard AXIsProcessTrusted() else { return }

    guard let app = NSWorkspace.shared.frontmostApplication else { return }
    guard allowed(app: app, url: nil) else {
      suppressed += 1
      return
    }

    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    let focused = chAxElement(axApp, kAXFocusedUIElementAttribute as String)
    let role = focused.flatMap { chAxString($0, kAXRoleAttribute as String) }
    let desc = focused.flatMap { chAxString($0, kAXDescriptionAttribute as String) }
      ?? focused.flatMap { chAxString($0, kAXTitleAttribute as String) }
    let value = focused.flatMap { chAxString($0, kAXValueAttribute as String) }
    var windowTitle: String?
    if let windows = chAxCopy(axApp, kAXWindowsAttribute as String) as? [AXUIElement],
       let first = windows.first
    {
      windowTitle = chAxString(first, kAXTitleAttribute as String)
    }

    let focusKey = "\(app.processIdentifier)|\(windowTitle ?? "")|\(role ?? "")|\(desc ?? "")|\((value ?? "").prefix(40))"
    guard focusKey != lastFocusKey else { return }
    lastFocusKey = focusKey

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
    append(record)
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
