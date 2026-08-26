// T3 Code screenshot-hotkey helper.
//
// Sidecar spawned by the desktop main process (macOS only). It has exactly two
// jobs, both driven over a line-oriented JSON protocol:
//
//   stdout →  {"type":"ready","version":1}
//             {"type":"flags","left":bool,"right":bool}      (left/right ⌘ state)
//             {"type":"capture","ok":true,"path":…,"width":n,"height":n,"appName":…}
//             {"type":"capture","ok":false,"reason":"permission-denied"|"no-window"|"capture-failed"}
//   stdin  ←  "capture\n"                                    (capture the frontmost window)
//
// Modifier flags are observed with a global NSEvent monitor, which macOS
// delivers WITHOUT any Accessibility/Input Monitoring permission — only actual
// key events are TCC-gated. The chord decision itself lives in the Electron
// main process so it can be unit tested; this helper only reports raw state.
// Screen Recording permission is required for the capture and is requested
// (attributed to the app, not this helper) on the first attempt.
//
// EOF on stdin means the parent is gone: exit so no orphan keeps a monitor.

import AppKit
import CoreGraphics
import ImageIO
import QuartzCore

// Device-specific modifier bits from IOKit's NX_DEVICELCMDKEYMASK /
// NX_DEVICERCMDKEYMASK. Documented as device-dependent, hence the keyCode
// fallback below.
private let deviceLeftCommandMask: UInt = 0x0008
private let deviceRightCommandMask: UInt = 0x0010
private let leftCommandKeyCode: UInt16 = 55
private let rightCommandKeyCode: UInt16 = 54

private let outputLock = NSLock()

private func emit(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload),
    let line = String(data: data, encoding: .utf8)
  else { return }
  outputLock.lock()
  defer { outputLock.unlock() }
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private func emitCaptureFailure(_ requestId: String, _ reason: String) {
  emit(["type": "capture", "id": requestId, "ok": false, "reason": reason])
}

// MARK: - Modifier state

private var leftCommandDown = false
private var rightCommandDown = false
private var lastEmittedLeft = false
private var lastEmittedRight = false

private func handleFlagsChanged(_ event: NSEvent) {
  let raw = event.modifierFlags.rawValue
  if !event.modifierFlags.contains(.command) {
    // No ⌘ at all: authoritative resync, covers any missed transition.
    leftCommandDown = false
    rightCommandDown = false
  } else {
    let deviceLeft = raw & deviceLeftCommandMask != 0
    let deviceRight = raw & deviceRightCommandMask != 0
    if deviceLeft || deviceRight {
      leftCommandDown = deviceLeft
      rightCommandDown = deviceRight
    } else {
      // Keyboard reports ⌘ without side bits: fall back to toggling the key
      // this event is about. The !command branch above corrects any desync.
      if event.keyCode == leftCommandKeyCode {
        leftCommandDown.toggle()
      } else if event.keyCode == rightCommandKeyCode {
        rightCommandDown.toggle()
      }
    }
  }
  if leftCommandDown != lastEmittedLeft || rightCommandDown != lastEmittedRight {
    lastEmittedLeft = leftCommandDown
    lastEmittedRight = rightCommandDown
    emit(["type": "flags", "left": leftCommandDown, "right": rightCommandDown])
  }
}

// MARK: - Capture

private func frontmostWindow() -> (windowID: CGWindowID, appName: String?, bounds: CGRect?)? {
  guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
  let pid = app.processIdentifier
  guard
    let windows = CGWindowListCopyWindowInfo(
      [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return nil }
  // Front-to-back order; the first normal-layer, visible window of the
  // frontmost app is the one the user is looking at.
  for info in windows {
    guard let ownerPid = info[kCGWindowOwnerPID as String] as? Int32, ownerPid == pid,
      let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
      let windowNumber = info[kCGWindowNumber as String] as? UInt32
    else { continue }
    if let alpha = info[kCGWindowAlpha as String] as? Double, alpha <= 0 { continue }
    let bounds = (info[kCGWindowBounds as String] as? [String: Any]).flatMap {
      CGRect(dictionaryRepresentation: $0 as CFDictionary)
    }
    return (CGWindowID(windowNumber), app.localizedName, bounds)
  }
  return nil
}

// kCGWindowBounds is in global display coordinates (origin top-left of the
// primary display, y down); NSWindow frames are Cocoa coordinates (origin
// bottom-left of the primary display, y up).
private func cocoaRect(fromGlobalTopLeft rect: CGRect) -> CGRect {
  let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
  return CGRect(
    x: rect.origin.x,
    y: primaryHeight - rect.origin.y - rect.height,
    width: rect.width,
    height: rect.height)
}

// Camera-style flash over the window that was just captured, so the feedback
// lands on the app the user is looking at, not on T3. Shown after the capture
// completes so the flash is never in the screenshot; screen-saver level keeps
// it visible while T3 comes to the front. Main thread only.
private func showCaptureFlash(over globalBounds: CGRect) {
  let frame = cocoaRect(fromGlobalTopLeft: globalBounds)
  guard frame.width > 1, frame.height > 1 else { return }
  let window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
  window.isReleasedWhenClosed = false
  window.level = .screenSaver
  window.backgroundColor = .white
  window.isOpaque = false
  window.hasShadow = false
  window.ignoresMouseEvents = true
  window.collectionBehavior = [.canJoinAllSpaces, .transient]
  window.alphaValue = 0.85
  window.orderFrontRegardless()
  NSAnimationContext.runAnimationGroup(
    { context in
      context.duration = 0.3
      context.timingFunction = CAMediaTimingFunction(name: .easeOut)
      window.animator().alphaValue = 0
    },
    completionHandler: {
      window.orderOut(nil)
    })
}

private func imageSize(atPath path: String) -> (width: Int, height: Int)? {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
    let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
    let height = properties[kCGImagePropertyPixelHeight as String] as? Int
  else { return nil }
  return (width, height)
}

private func handleCapture(_ requestId: String) {
  if !CGPreflightScreenCaptureAccess() {
    // Fires the Screen Recording TCC prompt on first ask; the verdict is
    // cached per-process, so the parent respawns this helper after a grant.
    CGRequestScreenCaptureAccess()
    emitCaptureFailure(requestId, "permission-denied")
    return
  }
  guard let target = frontmostWindow() else {
    emitCaptureFailure(requestId, "no-window")
    return
  }
  let path = NSTemporaryDirectory() + "t3-screenshot-" + UUID().uuidString + ".png"
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  // -x no sound, -o no window shadow, -l capture one window by ID.
  process.arguments = ["-x", "-o", "-l", String(target.windowID), path]
  do {
    try process.run()
    process.waitUntilExit()
  } catch {
    emitCaptureFailure(requestId, "capture-failed")
    return
  }
  guard process.terminationStatus == 0, let size = imageSize(atPath: path) else {
    try? FileManager.default.removeItem(atPath: path)
    emitCaptureFailure(requestId, "capture-failed")
    return
  }
  if let bounds = target.bounds {
    DispatchQueue.main.async { showCaptureFlash(over: bounds) }
  }
  var payload: [String: Any] = [
    "type": "capture", "id": requestId, "ok": true, "path": path,
    "width": size.width, "height": size.height,
  ]
  if let appName = target.appName { payload["appName"] = appName }
  if let bounds = target.bounds {
    // Global display points, top-left origin — the renderer's window.screenX/Y
    // coordinate space, so it can start the attach animation over this window.
    payload["windowBounds"] = [
      "x": bounds.origin.x, "y": bounds.origin.y,
      "width": bounds.width, "height": bounds.height,
    ]
  }
  emit(payload)
}

// MARK: - Main

setvbuf(stdout, nil, _IONBF, 0)

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { event in
  handleFlagsChanged(event)
}

let captureQueue = DispatchQueue(label: "capture")
DispatchQueue.global(qos: .utility).async {
  while let line = readLine(strippingNewline: true) {
    // "capture <requestId>": the id is echoed in the reply so the parent can
    // match replies to requests (a late reply after a timeout must not be
    // mistaken for the next capture's).
    if line == "capture" || line.hasPrefix("capture ") {
      let requestId = line.count > "capture ".count ? String(line.dropFirst("capture ".count)) : ""
      captureQueue.async { handleCapture(requestId) }
    }
  }
  // Parent gone. Let any in-flight capture reply drain, then die.
  captureQueue.async { exit(0) }
}

emit(["type": "ready", "version": 1])
app.run()
