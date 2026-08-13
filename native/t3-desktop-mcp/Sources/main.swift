import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

// t3-desktop-mcp — a macOS computer-use MCP server built on the Accessibility API.
//
// Design notes:
//  * Speaks newline-delimited JSON-RPC over stdio (MCP stdio transport).
//  * Uses AXUIElement directly, never AppleScript/System Events. AppleScript would
//    require a per-target-app kTCCServiceAppleEvents grant that macOS frequently
//    refuses to prompt for; AX needs only Accessibility.
//  * Ships as a bare executable so it runs as a child of the host app and inherits
//    the host's TCC grants. A separate .app bundle would get its own TCC identity
//    and require its own permissions.

// MARK: - AX helpers

func axCopy(_ el: AXUIElement, _ attr: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success ? value : nil
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    guard let v = axCopy(el, attr) else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func axBool(_ el: AXUIElement, _ attr: String) -> Bool? {
    (axCopy(el, attr) as? NSNumber)?.boolValue
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    (axCopy(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func axActions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

func axPoint(_ el: AXUIElement, _ attr: String) -> CGPoint? {
    guard let v = axCopy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func axSize(_ el: AXUIElement, _ attr: String) -> CGSize? {
    guard let v = axCopy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

/// Read an attribute that should hold another element, checking the type first.
/// A blind `as!` here would crash on any app that returns something unexpected.
func axElement(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
    guard let v = axCopy(el, attr), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func elementCenter(_ el: AXUIElement) -> CGPoint? {
    guard let p = axPoint(el, kAXPositionAttribute as String),
          let s = axSize(el, kAXSizeAttribute as String) else { return nil }
    return CGPoint(x: p.x + s.width / 2, y: p.y + s.height / 2)
}

// MARK: - Element registry
//
// Snapshots hand out short ids ("e12") that later calls reference, so the model
// clicks a named element instead of guessing pixel coordinates.

final class Registry {
    static var map: [String: AXUIElement] = [:]
    static var counter = 0
    /// App most recently inspected. Subsequent input is delivered to this
    /// process by default, so interaction stays in the background.
    static var targetPid: pid_t?

    static func reset() {
        map.removeAll()
        counter = 0
        targetPid = nil
    }

    static func add(_ el: AXUIElement) -> String {
        counter += 1
        let id = "e\(counter)"
        map[id] = el
        return id
    }

    static func get(_ id: String) -> AXUIElement? { map[id] }
}

// MARK: - App resolution

struct ResolvedApp {
    let app: NSRunningApplication
    let note: String?
}

/// Resolve an app by name, bundle id, or pid.
///
/// A single bundle id can have several running instances — Chrome routinely does.
/// Only some of them own windows, so prefer an instance that actually has one;
/// picking blindly is what makes System Events report "Invalid index".
func resolveApp(_ query: String) -> ResolvedApp? {
    let running = NSWorkspace.shared.runningApplications
    let lowered = query.lowercased()

    var matches: [NSRunningApplication]
    if let pid = Int32(query) {
        matches = running.filter { $0.processIdentifier == pid }
    } else {
        matches = running.filter { $0.bundleIdentifier?.lowercased() == lowered }
        if matches.isEmpty {
            matches = running.filter { ($0.localizedName ?? "").lowercased() == lowered }
        }
        if matches.isEmpty {
            matches = running.filter { ($0.localizedName ?? "").lowercased().contains(lowered) }
        }
    }
    guard !matches.isEmpty else { return nil }
    if matches.count == 1 { return ResolvedApp(app: matches[0], note: nil) }

    // Count windows only. An app element always has children (the menu bar, at
    // minimum), so testing children here would happily select a windowless instance.
    func windowCount(_ instance: NSRunningApplication) -> Int {
        let ax = AXUIElementCreateApplication(instance.processIdentifier)
        return ((axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []).count
    }

    // Prefer frontmost among instances that own windows, so the choice matches
    // what the user is actually looking at.
    let withWindows = matches.filter { windowCount($0) > 0 }
    let chosen = withWindows.first(where: { $0.isActive }) ?? withWindows.first ?? matches.first!
    let n = windowCount(chosen)
    let note = "\(matches.count) running instances of \(query); selected pid \(chosen.processIdentifier) "
        + (n > 0 ? "(\(n) window\(n == 1 ? "" : "s"))" : "(no instance has windows)")
    return ResolvedApp(app: chosen, note: note)
}

// MARK: - Tree walking

let interactiveRoles: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXMenuItem", "AXMenuButton", "AXLink", "AXComboBox",
    "AXSlider", "AXDisclosureTriangle", "AXSegmentedControl", "AXSearchField",
    "AXTabGroup", "AXIncrementor", "AXColorWell", "AXCell",
]

func truncate(_ s: String, _ n: Int) -> String {
    let flat = s.replacingOccurrences(of: "\n", with: " ")
    return flat.count <= n ? flat : String(flat.prefix(n)) + "…"
}

func walk(_ el: AXUIElement, depth: Int, lines: inout [String], budget: inout Int, maxDepth: Int) {
    guard budget > 0, depth <= maxDepth else { return }

    let role = axString(el, kAXRoleAttribute as String) ?? "AXUnknown"
    let title = axString(el, kAXTitleAttribute as String)
    let desc = axString(el, kAXDescriptionAttribute as String)
    let value = axString(el, kAXValueAttribute as String)
    let actions = axActions(el).filter { $0 != "AXShowMenu" }
    let isInteractive = interactiveRoles.contains(role) || !actions.isEmpty
    let label = title ?? desc ?? value

    // Emit a node only if it carries information: something actionable, or text.
    // Pure layout containers are traversed but not printed, which keeps the
    // outline small enough to be worth putting in a prompt.
    if isInteractive || label != nil {
        var parts = ["\(String(repeating: "  ", count: depth))"]
        if isInteractive {
            parts.append("[\(Registry.add(el))] ")
        } else {
            parts.append("     ")
        }
        parts.append(role.replacingOccurrences(of: "AX", with: ""))
        if let l = label { parts.append(" \"\(truncate(l, 120))\"") }
        // Show the current contents whenever they are not already the label.
        // Fields commonly label themselves with AXDescription ("Address and
        // search bar") and keep the typed text in AXValue, so gating this on
        // AXTitle hid what the field actually contains.
        if let v = value, v != label {
            parts.append(" value=\"\(truncate(v, 80))\"")
        }
        if axBool(el, kAXEnabledAttribute as String) == false { parts.append(" (disabled)") }
        if axBool(el, kAXFocusedAttribute as String) == true { parts.append(" (focused)") }
        lines.append(parts.joined())
        budget -= 1
    }

    for child in axChildren(el) {
        walk(child, depth: depth + 1, lines: &lines, budget: &budget, maxDepth: maxDepth)
    }
}

// MARK: - Input synthesis

// MOUSE_TARGETING
//
// Coordinate mouse events reach a background window through SkyLight, so the
// agent can click in one app while the user works in another and the physical
// cursor never moves. Three things are all required — miss any one and the event
// is silently dropped:
//
//   1. Window addressing. The event carries the target window id in fields
//      51/91/92 plus window-local coordinates via CGEventSetWindowLocation.
//   2. SLEventSetIntegerValueField, NOT CGEvent.setIntegerValueField. The public
//      setter takes a CGEventField enum and CGEventField(rawValue:) returns nil
//      for the undocumented fields (51/58/91/92), so those stamps vanish.
//   3. activate_without_raise. A background window will not accept routed input
//      until its AppKit-active state is flipped, which is done without raising
//      the window or switching Spaces.
//
// Delivery goes through both SLEventPostToPid (reaches Chromium/Catalyst, which
// ignore the public path because it skips the activity-monitor tickle) and
// CGEvent.postToPid (lands on AppKit targets where the SkyLight path drops).
//
// Ported from trycua/cua's cua-driver, which in turn takes focus-without-raise
// from yabai. These are private SPIs resolved by dlsym: if any fail to resolve
// we fall back to the global HID tap, which works but moves the user's cursor.
//
// Summary:
//   * type_text / press_key      -> postToPid, background-safe
//   * click by element_id        -> AXPress, background-safe, no cursor movement
//   * click/drag by coordinates  -> SkyLight background path, cursor stays put
//   * any of the above, degraded -> global HID tap, takes over the pointer

/// Deliver an event to a specific process when we know one, otherwise to the
/// global HID tap.
///
/// Targeting a pid is what lets the agent work in the background: the event goes
/// straight to that application, so the physical cursor does not jump, focus is
/// not stolen, and the user can keep working in another app meanwhile. The global
/// tap is a fallback for raw-coordinate calls where no app is known, and it does
/// take over the machine.
func post(_ event: CGEvent?, to pid: pid_t?) {
    guard let event else { return }
    if let pid {
        event.postToPid(pid)
    } else {
        event.post(tap: .cghidEventTap)
    }
}

func pidOf(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

// MARK: - SkyLight background input

/// Private SPIs behind background mouse delivery. All optional: when a symbol
/// stops resolving on a future macOS the caller degrades to the global HID tap
/// rather than failing.
enum SkyLight {
    typealias PostToPidFn = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Void
    typealias SetIntFieldFn = @convention(c) (UnsafeMutableRawPointer, UInt32, Int64) -> Void
    typealias SetWindowLocFn = @convention(c) (UnsafeMutableRawPointer, CGPoint) -> Void
    typealias PostEventRecordFn = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<UInt8>) -> Int32
    typealias GetFrontProcessFn = @convention(c) (UnsafeMutableRawPointer) -> Int32
    typealias GetProcessForPIDFn = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus
    typealias AXGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<UInt32>) -> AXError

    static let skyHandle = dlopen(
        "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight", RTLD_LAZY)
    static let appServices = dlopen(
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY)

    static let postToPid: PostToPidFn? = load("SLEventPostToPid", skyHandle)
    static let setIntField: SetIntFieldFn? = load("SLEventSetIntegerValueField", skyHandle)
    static let setWindowLocation: SetWindowLocFn? = load("CGEventSetWindowLocation", skyHandle)
        ?? load("CGEventSetWindowLocation", dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY))
    static let postEventRecord: PostEventRecordFn? = load("SLPSPostEventRecordTo", skyHandle)
    static let getFrontProcess: GetFrontProcessFn? = load("_SLPSGetFrontProcess", skyHandle)
    static let getProcessForPID: GetProcessForPIDFn? = load("GetProcessForPID", appServices)
    static let axGetWindow: AXGetWindowFn? = load("_AXUIElementGetWindow", appServices)

    static func load<T>(_ name: String, _ handle: UnsafeMutableRawPointer?) -> T? {
        guard let handle, let sym = dlsym(handle, name) else { return nil }
        return unsafeBitCast(sym, to: T.self)
    }

    static var available: Bool {
        postToPid != nil && setIntField != nil && postEventRecord != nil
            && getFrontProcess != nil && getProcessForPID != nil && axGetWindow != nil
    }

    static func windowID(_ window: AXUIElement) -> UInt32? {
        guard let fn = axGetWindow else { return nil }
        var wid: UInt32 = 0
        return fn(window, &wid) == .success ? wid : nil
    }

    /// Make the target window able to accept routed input without raising it or
    /// switching Spaces. Deliberately skips SLPSSetFrontProcessWithOptions —
    /// omitting it keeps Chromium's user-activation gate open.
    @discardableResult
    static func activateWithoutRaise(pid: pid_t, wid: UInt32) -> Bool {
        guard let post = postEventRecord, let front = getFrontProcess, let forPID = getProcessForPID
        else { return false }

        // PSNs are 8 raw bytes here, not the Swift struct's layout guarantees.
        var previous = [UInt8](repeating: 0, count: 8)
        var target = [UInt8](repeating: 0, count: 8)
        let gotPrevious = previous.withUnsafeMutableBufferPointer {
            front(UnsafeMutableRawPointer($0.baseAddress!)) == 0
        }
        guard gotPrevious else { return false }

        var psn = ProcessSerialNumber()
        guard forPID(pid, &psn) == 0 else { return false }
        withUnsafeBytes(of: &psn) { raw in for i in 0..<8 { target[i] = raw[i] } }

        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = 0x0D
        record[0x3C] = UInt8(wid & 0xFF)
        record[0x3D] = UInt8((wid >> 8) & 0xFF)
        record[0x3E] = UInt8((wid >> 16) & 0xFF)
        record[0x3F] = UInt8((wid >> 24) & 0xFF)

        record[0x8A] = 0x02  // defocus the outgoing front process
        let defocused = previous.withUnsafeMutableBufferPointer { p in
            record.withUnsafeMutableBufferPointer { r in
                post(UnsafeMutableRawPointer(p.baseAddress!), r.baseAddress!) == 0
            }
        }
        record[0x8A] = 0x01  // focus the target
        let focused = target.withUnsafeMutableBufferPointer { p in
            record.withUnsafeMutableBufferPointer { r in
                post(UnsafeMutableRawPointer(p.baseAddress!), r.baseAddress!) == 0
            }
        }
        return defocused && focused
    }

    /// Stamp the window-routing fields and deliver down both paths.
    static func postMouse(
        _ event: CGEvent, pid: pid_t, wid: UInt32, windowOrigin: CGPoint,
        screen: CGPoint, clickState: Int64, button: Int64, subtype: Int64, groupID: Int64
    ) {
        guard let post = postToPid, let setField = setIntField else { return }
        let ptr = Unmanaged.passUnretained(event).toOpaque()
        setWindowLocation?(ptr, CGPoint(x: screen.x - windowOrigin.x, y: screen.y - windowOrigin.y))
        let w = Int64(wid)
        setField(ptr, 1, clickState)   // click state
        setField(ptr, 3, button)       // button number
        setField(ptr, 7, subtype)      // subtype: 3 touch for clicks, 0 for drags
        setField(ptr, 51, w)           // window number
        setField(ptr, 58, groupID)     // click-group id, coalesces the gesture
        setField(ptr, 91, w)           // window under mouse pointer
        setField(ptr, 92, w)           // ...that can handle this event
        setField(ptr, 40, Int64(pid))  // target pid (Chromium synthetic filter)
        post(pid, ptr)
        event.postToPid(pid)
    }
}

/// A window that background mouse events can be addressed to.
struct WindowTarget {
    let pid: pid_t
    let wid: UInt32
    let frame: CGRect
    var origin: CGPoint { frame.origin }
}

func makeWindowTarget(pid: pid_t, window: AXUIElement) -> WindowTarget? {
    guard let wid = SkyLight.windowID(window) else { return nil }
    let origin = axPoint(window, kAXPositionAttribute as String) ?? .zero
    let size = axSize(window, kAXSizeAttribute as String) ?? .zero
    return WindowTarget(pid: pid, wid: wid, frame: CGRect(origin: origin, size: size))
}

func windowTarget(for element: AXUIElement) -> WindowTarget? {
    guard let pid = pidOf(element) else { return nil }
    let window = axElement(element, kAXWindowAttribute as String)
        ?? (axCopy(AXUIElementCreateApplication(pid), kAXWindowsAttribute as String) as? [AXUIElement])?.first
    guard let window else { return nil }
    return makeWindowTarget(pid: pid, window: window)
}

/// The frontmost on-screen window containing `point`.
///
/// `CGWindowListCopyWindowInfo` returns windows front to back, so the first
/// hit is the one a person clicking there would reach.
func windowTarget(under point: CGPoint) -> WindowTarget? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for window in windows {
        // These arrive as NSNumber, which does not bridge straight to pid_t or
        // UInt32 — casting directly returns nil and the lookup silently fails.
        guard let bounds = window[kCGWindowBounds as String] as? [String: Any],
            let pidValue = window[kCGWindowOwnerPID as String] as? NSNumber,
            let numberValue = window[kCGWindowNumber as String] as? NSNumber,
            let x = (bounds["X"] as? NSNumber)?.doubleValue,
            let y = (bounds["Y"] as? NSNumber)?.doubleValue,
            let width = (bounds["Width"] as? NSNumber)?.doubleValue,
            let height = (bounds["Height"] as? NSNumber)?.doubleValue
        else { continue }
        let pid = pid_t(pidValue.int32Value)
        let number = numberValue.uint32Value
        // Skip the agent's own pointer, which sits above everything by design.
        if pid == getpid() { continue }
        if CGRect(x: x, y: y, width: width, height: height).contains(point) {
            return WindowTarget(
                pid: pid,
                wid: number,
                frame: CGRect(x: x, y: y, width: width, height: height)
            )
        }
    }
    return nil
}

func windowTarget(forPid pid: pid_t) -> WindowTarget? {
    guard let window = (axCopy(AXUIElementCreateApplication(pid), kAXWindowsAttribute as String) as? [AXUIElement])?.first
    else { return nil }
    return makeWindowTarget(pid: pid, window: window)
}

/// Whether an element lives inside rendered web content.
///
/// Chromium exposes AXPress on web elements and returns success without doing
/// anything, so callers need to know when to bypass it and click for real.
func isInWebContent(_ element: AXUIElement) -> Bool {
    var node: AXUIElement? = element
    for _ in 0..<14 {
        guard let current = node else { return false }
        if let role = axString(current, kAXRoleAttribute as String),
           role == "AXWebArea" { return true }
        node = axElement(current, kAXParentAttribute as String)
    }
    return false
}

/// Centre of the part of an element that is actually on screen.
///
/// A scrollable element reports its *content* frame, which can be far taller
/// than the window showing it — the raw centre of a long document's text area
/// lands below the window entirely, and the click misses. Clipping to the
/// window keeps the point somewhere clickable.
func visibleCenter(of element: AXUIElement) -> CGPoint? {
    guard let position = axPoint(element, kAXPositionAttribute as String),
          let size = axSize(element, kAXSizeAttribute as String) else { return nil }
    let elementRect = CGRect(origin: position, size: size)
    guard let target = windowTarget(for: element), !target.frame.isEmpty else {
        return CGPoint(x: elementRect.midX, y: elementRect.midY)
    }
    let visible = elementRect.intersection(target.frame)
    let rect = visible.isNull || visible.isEmpty ? elementRect : visible
    return CGPoint(x: rect.midX, y: rect.midY)
}

var clickGroupCounter: Int64 = 0x4000

/// Background click. Returns false if the SkyLight path is unavailable, so the
/// caller can fall back to the cursor-moving global tap.
func backgroundClick(_ target: WindowTarget, at point: CGPoint, clickCount: Int) -> Bool {
    guard SkyLight.available else { return false }
    CursorOverlay.shared.press(at: point)
    SkyLight.activateWithoutRaise(pid: target.pid, wid: target.wid)
    usleep(80_000)

    clickGroupCounter += 1
    let group = clickGroupCounter
    let src = CGEventSource(stateID: .combinedSessionState)

    // A background window has stale cursor-tracking state, so a bare mouseDown
    // hit-tests "outside" the control and never fires.
    if let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        SkyLight.postMouse(move, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: 0, button: 0, subtype: 3, groupID: group)
    }
    usleep(12_000)
    for i in 1...max(1, clickCount) {
        if let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) {
            SkyLight.postMouse(down, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                               screen: point, clickState: Int64(i), button: 0, subtype: 3, groupID: group)
        }
        usleep(28_000)
        if let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
            SkyLight.postMouse(up, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                               screen: point, clickState: Int64(i), button: 0, subtype: 3, groupID: group)
        }
        if i < clickCount { usleep(80_000) }
    }
    return true
}

func backgroundScroll(_ target: WindowTarget, at point: CGPoint, dx: Int32, dy: Int32, steps: Int) -> Bool {
    guard SkyLight.available, let post = SkyLight.postToPid, let setField = SkyLight.setIntField
    else { return false }
    CursorOverlay.shared.show(at: point)
    SkyLight.activateWithoutRaise(pid: target.pid, wid: target.wid)
    usleep(80_000)
    clickGroupCounter += 1
    let group = clickGroupCounter

    // Prime the window's hit-test location. A background window keeps a stale
    // one, and the wheel then lands on nothing even though it is delivered.
    if let move = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState),
                          mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        SkyLight.postMouse(move, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: 0, button: 0, subtype: 3, groupID: group)
    }
    usleep(12_000)

    let local = CGPoint(x: point.x - target.origin.x, y: point.y - target.origin.y)
    for _ in 0..<max(1, steps) {
        guard let wheel = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .hidSystemState),
                                  units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
        else { continue }
        // Scroll events are created at (0, 0) and the receiver hit-tests the
        // wheel against the event location, so it must be anchored at the
        // target. Missing this is why a delivered scroll appears to do nothing.
        wheel.location = point

        let ptr = Unmanaged.passUnretained(wheel).toOpaque()
        SkyLight.setWindowLocation?(ptr, local)
        let w = Int64(target.wid)
        setField(ptr, 51, w)
        setField(ptr, 91, w)
        setField(ptr, 92, w)
        setField(ptr, 40, Int64(target.pid))
        post(target.pid, ptr)
        wheel.postToPid(target.pid)
        usleep(30_000)
    }
    return true
}

func backgroundRightClick(_ target: WindowTarget, at point: CGPoint) -> Bool {
    guard SkyLight.available else { return false }
    CursorOverlay.shared.press(at: point)
    SkyLight.activateWithoutRaise(pid: target.pid, wid: target.wid)
    usleep(80_000)
    clickGroupCounter += 1
    let group = clickGroupCounter
    let src = CGEventSource(stateID: .combinedSessionState)
    if let down = CGEvent(mouseEventSource: src, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right) {
        SkyLight.postMouse(down, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: 1, button: 1, subtype: 3, groupID: group)
    }
    usleep(28_000)
    if let up = CGEvent(mouseEventSource: src, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) {
        SkyLight.postMouse(up, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: 1, button: 1, subtype: 3, groupID: group)
    }
    return true
}

func backgroundDrag(_ target: WindowTarget, from start: CGPoint, to end: CGPoint) -> Bool {
    guard SkyLight.available else { return false }
    CursorOverlay.shared.press(at: start)
    SkyLight.activateWithoutRaise(pid: target.pid, wid: target.wid)
    usleep(80_000)
    clickGroupCounter += 1
    let group = clickGroupCounter
    let src = CGEventSource(stateID: .combinedSessionState)

    func send(_ type: CGEventType, _ point: CGPoint, _ clickState: Int64, _ subtype: Int64) {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
        else { return }
        SkyLight.postMouse(e, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: clickState, button: 0, subtype: subtype, groupID: group)
    }

    send(.mouseMoved, start, 0, 3)
    usleep(12_000)
    send(.leftMouseDown, start, 1, 3)
    usleep(28_000)
    // Drags carry the normal subtype rather than touch.
    let steps = 24
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let step = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        send(.leftMouseDragged, step, 1, 0)
        if i % 4 == 0 { CursorOverlay.shared.show(at: step) }
        usleep(15_000)
    }
    usleep(40_000)
    send(.leftMouseUp, end, 1, 3)
    CursorOverlay.shared.press(at: end)
    return true
}

func postClick(at point: CGPoint, clickCount: Int = 1, pid: pid_t?) {
    CursorOverlay.shared.press(at: point)
    let src = CGEventSource(stateID: .combinedSessionState)
    for i in 1...clickCount {
        let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
        let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        post(down, to: pid)
        post(up, to: pid)
        if i < clickCount { usleep(80_000) }
    }
}

func typeText(_ text: String, pid: pid_t?) {
    let src = CGEventSource(stateID: .combinedSessionState)
    // Send in small UTF-16 chunks: keyboardSetUnicodeString has a length cap,
    // and per-chunk events keep long strings from being dropped.
    for chunk in Array(text).chunked(into: 16) {
        var utf16 = Array(String(chunk).utf16)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { continue }
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        post(down, to: pid)
        post(up, to: pid)
        usleep(8_000)
    }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38,
    "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1,
    "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
]

func pressKey(_ key: String, modifiers: [String], pid: pid_t?) -> String? {
    guard let code = keyCodes[key.lowercased()] else { return "unknown key: \(key)" }
    var flags: CGEventFlags = []
    for m in modifiers.map({ $0.lowercased() }) {
        switch m {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: return "unknown modifier: \(m)"
        }
    }
    let src = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    down?.flags = flags
    up?.flags = flags
    post(down, to: pid)
    post(up, to: pid)
    return nil
}

// MARK: - Tool implementations

func toolListApps() -> String {
    var out: [String] = []
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }

    for app in apps {
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        let windows = (axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        var line = "\(app.localizedName ?? "?")  [\(app.bundleIdentifier ?? "-")]  pid=\(app.processIdentifier)  windows=\(windows.count)"
        if app.isActive { line += "  FRONTMOST" }
        out.append(line)
    }
    return out.isEmpty ? "No apps found." : out.joined(separator: "\n")
}

func toolGetAppState(_ args: [String: Any]) -> String {
    guard let query = args["app"] as? String else { return "error: missing required argument 'app'" }
    guard let resolved = resolveApp(query) else { return "error: no running app matching \(query)" }

    let app = resolved.app
    let maxDepth = (args["max_depth"] as? Int) ?? 18
    var budget = (args["max_elements"] as? Int) ?? 800

    Registry.reset()
    Registry.targetPid = app.processIdentifier
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var windows = (axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []

    var header = "\(app.localizedName ?? "?") [\(app.bundleIdentifier ?? "-")] pid=\(app.processIdentifier) frontmost=\(app.isActive) windows=\(windows.count)"
    if let note = resolved.note { header += "\nnote: \(note)" }

    // Narrow to one window. "agent" is the Chrome window this server owns, which
    // keeps the tree (and any clicks derived from it) off the user's own tabs.
    if let scope = args["window"] {
        if let name = scope as? String, name == "agent" {
            guard let agent = Chrome.agentAXWindow() else {
                return header + "\n\n(no agent window yet — call browser_open_tab first)"
            }
            windows = [agent.element]
            Registry.targetPid = agent.pid
            header += "\nscope: agent window only"
        } else if let index = scope as? Int {
            guard index >= 0, index < windows.count else {
                return header + "\n\n(window \(index) is out of range)"
            }
            windows = [windows[index]]
            header += "\nscope: window \(index) only"
        }
    }

    if windows.isEmpty {
        return header + "\n\n(this process has no accessibility windows — if you expected one, another instance of the same app may own it; check list_apps)"
    }

    var lines: [String] = []
    for (i, w) in windows.enumerated() {
        let title = axString(w, kAXTitleAttribute as String) ?? "<untitled>"
        lines.append("── window \(i): \"\(title)\"")
        walk(w, depth: 1, lines: &lines, budget: &budget, maxDepth: maxDepth)
    }
    if budget <= 0 {
        lines.append("… element budget reached; raise max_elements for more")
    }
    return header + "\n\n" + lines.joined(separator: "\n")
}

/// Which process should receive synthetic input.
///
/// Order matters: an element knows its own owner, an explicit `app` argument is
/// the caller's intent, and the last inspected app is the sensible default.
/// Returning nil means global delivery, which moves the real cursor.
func resolveTargetPid(_ args: [String: Any], element: AXUIElement? = nil) -> pid_t? {
    if let element, let pid = pidOf(element) { return pid }
    if let query = args["app"] as? String, let resolved = resolveApp(query) {
        return resolved.app.processIdentifier
    }
    return Registry.targetPid
}

func toolClick(_ args: [String: Any]) -> String {
    let clickCount = (args["click_count"] as? Int) ?? 1

    if let id = args["element_id"] as? String {
        guard let el = Registry.get(id) else {
            return "error: unknown element_id \(id) — call get_app_state again to refresh ids"
        }
        // Prefer the semantic action; it works even when the element is scrolled
        // out of view or overlapped, where a synthetic click would hit the wrong thing.
        //
        // Web content is the exception: Blink reports AXPress as supported and
        // returns success, but does not act on it — a link "pressed" this way
        // never navigates. Inside a web area, go straight to a real click.
        if axActions(el).contains(kAXPressAction as String), clickCount == 1, !isInWebContent(el) {
            if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
                let label = axString(el, kAXTitleAttribute as String) ?? axString(el, kAXDescriptionAttribute as String) ?? id
                return "pressed \(id) \"\(label)\" via AXPress"
            }
        }
        // Coordinate fallback: see MOUSE_TARGETING.
        guard let center = visibleCenter(of: el) else { return "error: \(id) has no screen position and AXPress failed" }
        AgentCursor.shared.show(at: center)
        if let target = windowTarget(for: el), backgroundClick(target, at: center, clickCount: clickCount) {
            return "clicked \(id) at (\(Int(center.x)), \(Int(center.y))) in background"
        }
        postClick(at: center, clickCount: clickCount, pid: nil)
        return "clicked \(id) at (\(Int(center.x)), \(Int(center.y))) via cursor"
    }

    if let x = args["x"] as? Double, let y = args["y"] as? Double {
        let point = CGPoint(x: x, y: y)
        AgentCursor.shared.show(at: point)
        // Prefer the app the caller named, then whatever window actually sits
        // under the point. Without the second lookup a caller who omits `app`
        // falls through to the shared cursor, which is exactly what desktop
        // control should avoid.
        let target = resolveTargetPid(args).flatMap(windowTarget(forPid:)) ?? windowTarget(under: point)
        if let target, backgroundClick(target, at: point, clickCount: clickCount) {
            return "clicked at (\(Int(x)), \(Int(y))) in background"
        }
        postClick(at: point, clickCount: clickCount, pid: nil)
        return "clicked at (\(Int(x)), \(Int(y))) via cursor"
    }
    return "error: provide either element_id, or both x and y"
}

func toolTypeText(_ args: [String: Any]) -> String {
    guard let text = args["text"] as? String else { return "error: missing required argument 'text'" }
    var element: AXUIElement?
    if let id = args["element_id"] as? String {
        guard let el = Registry.get(id) else { return "error: unknown element_id \(id)" }
        element = el
        // Focus the field within its own app rather than raising the app, so a
        // background window still receives the text.
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(60_000)
    }
    typeText(text, pid: resolveTargetPid(args, element: element))
    return "typed \(text.count) characters"
}

func toolPressKey(_ args: [String: Any]) -> String {
    guard let key = args["key"] as? String else { return "error: missing required argument 'key'" }
    let mods = (args["modifiers"] as? [String]) ?? []
    if let err = pressKey(key, modifiers: mods, pid: resolveTargetPid(args)) { return "error: \(err)" }
    return "pressed \(mods.isEmpty ? key : mods.joined(separator: "+") + "+" + key)"
}

func toolScroll(_ args: [String: Any]) -> String {
    let direction = ((args["direction"] as? String) ?? "down").lowercased()
    let amount = (args["amount"] as? Int) ?? 5

    var dy: Int32 = 0
    var dx: Int32 = 0
    switch direction {
    case "up": dy = 1
    case "down": dy = -1
    case "left": dx = 1
    case "right": dx = -1
    default: return "error: direction must be up, down, left, or right"
    }

    let element = (args["element_id"] as? String).flatMap { Registry.get($0) }
    let target = element.flatMap { windowTarget(for: $0) }
        ?? resolveTargetPid(args).flatMap { windowTarget(forPid: $0) }

    if let target {
        // Scroll follows the pointer, so aim at the element when given one and
        // otherwise at the middle of the window.
        let point = element.flatMap { visibleCenter(of: $0) }
            ?? CGPoint(x: target.origin.x + 200, y: target.origin.y + 200)
        if backgroundScroll(target, at: point, dx: dx, dy: dy, steps: abs(amount)) {
            return "scrolled \(direction) by \(amount) in background"
        }
    }

    // Fallback: drive the real pointer.
    if let el = element, let center = elementCenter(el) {
        CGWarpMouseCursorPosition(center)
        usleep(30_000)
    }
    let src = CGEventSource(stateID: .combinedSessionState)
    for _ in 0..<abs(amount) {
        post(CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2,
                     wheel1: dy, wheel2: dx, wheel3: 0), to: nil)
        usleep(15_000)
    }
    return "scrolled \(direction) by \(amount) via cursor"
}

func toolActivateApp(_ args: [String: Any]) -> String {
    guard let query = args["app"] as? String else { return "error: missing required argument 'app'" }
    guard let resolved = resolveApp(query) else { return "error: no running app matching \(query)" }
    // Requests are handled off the main thread; NSRunningApplication.activate is
    // AppKit and belongs on main.
    DispatchQueue.main.sync { resolved.app.activate(options: []) }
    usleep(250_000)
    return "activated \(resolved.app.localizedName ?? query) (pid \(resolved.app.processIdentifier))"
}

// MARK: - Screen capture

/// Capture a window as PNG. Runs the async ScreenCaptureKit call on a background
/// executor and blocks the JSON-RPC loop until it lands, with a timeout so a
/// wedged capture can never hang the server.
func captureWindowPNG(pid: pid_t, maxWidth: Int) -> Data? {
    let semaphore = DispatchSemaphore(value: 0)
    var result: Data?

    Task.detached {
        defer { semaphore.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            // Largest on-screen window belonging to the target process; smaller
            // ones are usually palettes or overlays rather than the main UI.
            let candidates = content.windows
                .filter { $0.owningApplication?.processID == pid }
                .sorted { ($0.frame.width * $0.frame.height) > ($1.frame.width * $1.frame.height) }
            guard let window = candidates.first else { return }

            let config = SCStreamConfiguration()
            let scale = min(1.0, Double(maxWidth) / max(1.0, Double(window.frame.width)))
            config.width = Int(window.frame.width * scale)
            config.height = Int(window.frame.height * scale)
            config.showsCursor = false

            let image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: window),
                configuration: config)
            result = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        } catch {
            result = nil
        }
    }

    _ = semaphore.wait(timeout: .now() + 15)
    return result
}

/// Capture a whole display. Window capture covers one app; this is for seeing
/// the desktop as a whole, including every monitor the user has attached.
func captureDisplayPNG(index: Int, maxWidth: Int) -> (data: Data, width: Int, height: Int)? {
    let semaphore = DispatchSemaphore(value: 0)
    var result: (Data, Int, Int)?
    Task.detached {
        defer { semaphore.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            let displays = content.displays
            guard index >= 0, index < displays.count else { return }
            let display = displays[index]
            let config = SCStreamConfiguration()
            let scale = min(1.0, Double(maxWidth) / max(1.0, Double(display.width)))
            config.width = Int(Double(display.width) * scale)
            config.height = Int(Double(display.height) * scale)
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(display: display, excludingWindows: []),
                configuration: config)
            if let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) {
                result = (png, display.width, display.height)
            }
        } catch {
            result = nil
        }
    }
    _ = semaphore.wait(timeout: .now() + 20)
    return result
}

func toolListDisplays(_ args: [String: Any]) -> String {
    let semaphore = DispatchSemaphore(value: 0)
    var lines: [String] = []
    Task.detached {
        defer { semaphore.signal() }
        if let content = try? await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true) {
            for (i, display) in content.displays.enumerated() {
                let frame = display.frame
                lines.append("[\(i)] \(display.width)x\(display.height) "
                    + "at (\(Int(frame.origin.x)), \(Int(frame.origin.y)))")
            }
        }
    }
    _ = semaphore.wait(timeout: .now() + 20)
    if lines.isEmpty { return "error: could not enumerate displays" }
    return "\(lines.count) display\(lines.count == 1 ? "" : "s"):\n" + lines.joined(separator: "\n")
}

// MARK: - Additional input synthesis

func postRightClick(at point: CGPoint, pid: pid_t?) {
    CursorOverlay.shared.press(at: point)
    let src = CGEventSource(stateID: .combinedSessionState)
    post(CGEvent(mouseEventSource: src, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right), to: pid)
    post(CGEvent(mouseEventSource: src, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right), to: pid)
}

func postDrag(from start: CGPoint, to end: CGPoint, pid: pid_t?) {
    let src = CGEventSource(stateID: .combinedSessionState)
    // Deliver a move to the press location first: many views only begin drag
    // tracking when the press arrives where the pointer already is, and without
    // it the gesture degrades into a plain click.
    //
    // When targeting a pid this is a synthetic move sent to that app only, so
    // the user's real cursor stays put. Only the no-pid fallback warps it.
    if pid == nil {
        CGWarpMouseCursorPosition(start)
    }
    post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left), to: pid)
    usleep(80_000)
    post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left), to: pid)
    usleep(80_000)
    // Interpolate: a single jump often reads as a click, since many views need
    // intermediate drag events to start tracking.
    let steps = 24
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left), to: pid)
        usleep(15_000)
    }
    usleep(80_000)
    post(CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left), to: pid)
}

// MARK: - Additional tools

func resolvePoint(_ args: [String: Any], xKey: String, yKey: String, idKey: String) -> CGPoint? {
    if let id = args[idKey] as? String, let el = Registry.get(id) { return visibleCenter(of: el) }
    if let x = args[xKey] as? Double, let y = args[yKey] as? Double { return CGPoint(x: x, y: y) }
    return nil
}

func toolRightClick(_ args: [String: Any]) -> String {
    guard let point = resolvePoint(args, xKey: "x", yKey: "y", idKey: "element_id") else {
        return "error: provide either element_id, or both x and y"
    }
    let element = (args["element_id"] as? String).flatMap { Registry.get($0) }
    let target = element.flatMap { windowTarget(for: $0) }
        ?? resolveTargetPid(args).flatMap { windowTarget(forPid: $0) }
    if let target, backgroundRightClick(target, at: point) {
        return "right-clicked at (\(Int(point.x)), \(Int(point.y))) in background"
    }
    postRightClick(at: point, pid: nil)
    return "right-clicked at (\(Int(point.x)), \(Int(point.y))) via cursor"
}

func toolDrag(_ args: [String: Any]) -> String {
    guard let start = resolvePoint(args, xKey: "from_x", yKey: "from_y", idKey: "from_element_id") else {
        return "error: provide from_element_id, or both from_x and from_y"
    }
    guard let end = resolvePoint(args, xKey: "to_x", yKey: "to_y", idKey: "to_element_id") else {
        return "error: provide to_element_id, or both to_x and to_y"
    }
    let element = (args["from_element_id"] as? String).flatMap { Registry.get($0) }
    let target = element.flatMap { windowTarget(for: $0) }
        ?? resolveTargetPid(args).flatMap { windowTarget(forPid: $0) }
    if let target, backgroundDrag(target, from: start, to: end) {
        return "dragged from (\(Int(start.x)), \(Int(start.y))) to (\(Int(end.x)), \(Int(end.y))) in background"
    }
    postDrag(from: start, to: end, pid: nil)
    return "dragged from (\(Int(start.x)), \(Int(start.y))) to (\(Int(end.x)), \(Int(end.y))) via cursor"
}

func toolSetValue(_ args: [String: Any]) -> String {
    guard let id = args["element_id"] as? String else { return "error: missing required argument 'element_id'" }
    guard let value = args["value"] as? String else { return "error: missing required argument 'value'" }
    guard let el = Registry.get(id) else { return "error: unknown element_id \(id)" }
    // Setting AXValue replaces field contents atomically, which is far more
    // reliable than select-all-then-type for long strings.
    let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
    if err != .success {
        return "error: could not set value on \(id) (AX error \(err.rawValue)); try click + type_text instead"
    }
    return "set \(id) to \(value.count) characters"
}

func toolSelectText(_ args: [String: Any]) -> String {
    guard let id = args["element_id"] as? String else { return "error: missing required argument 'element_id'" }
    guard let el = Registry.get(id) else { return "error: unknown element_id \(id)" }

    let text = axString(el, kAXValueAttribute as String) ?? ""
    let start = (args["start"] as? Int) ?? 0
    let length = (args["length"] as? Int) ?? max(0, text.count - start)
    var range = CFRange(location: start, length: length)
    guard let axRange = AXValueCreate(.cfRange, &range) else { return "error: could not build range" }

    let err = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, axRange)
    if err != .success { return "error: could not select text on \(id) (AX error \(err.rawValue))" }
    let selected = axString(el, kAXSelectedTextAttribute as String) ?? ""
    return "selected \(selected.count) characters in \(id)"
}

// MARK: - Chrome agent window
//
// The agent gets its own Chrome window and only ever drives tabs inside it, so
// the user can keep browsing their own tabs undisturbed. Tab management goes
// through Chrome's scripting interface (the same surface a browser extension
// would use); page interaction stays on the AX + SkyLight path, addressed to the
// agent window's id, so it never touches the user's window.

/// A script result. `Result` is not used because its failure type must conform
/// to `Error`, and these are human-readable messages headed straight into a
/// tool response.
enum ScriptOutcome {
    case success(String)
    case failure(String)
}

enum WindowOutcome {
    case success(Int)
    case failure(String)
}

enum Chrome {
    /// Persisted so a restarted server reattaches to the same window instead of
    /// stranding it and opening another. MCP servers are spawned per session;
    /// the browser window outlives them.
    static let stateURL: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let dir = base.appendingPathComponent("t3-desktop-mcp", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("agent-window")
    }()

    private static var cachedWindowID: Int?
    private static var didLoadState = false

    static var agentWindowID: Int? {
        get {
            if !didLoadState {
                didLoadState = true
                if let text = try? String(contentsOf: stateURL, encoding: .utf8) {
                    cachedWindowID = Int(text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines))
                }
            }
            return cachedWindowID
        }
        set {
            didLoadState = true
            cachedWindowID = newValue
            if let newValue {
                try? String(newValue).write(to: stateURL, atomically: true, encoding: .utf8)
            } else {
                try? FileManager.default.removeItem(at: stateURL)
            }
        }
    }

    /// The stored id, or nil if that window has since been closed.
    static func liveAgentWindowID() -> Int? {
        guard let id = agentWindowID else { return nil }
        if windowExists(id) { return id }
        agentWindowID = nil
        return nil
    }

    /// NSAppleScript is not thread-safe and the JSON-RPC loop runs off-main.
    static func run(_ source: String) -> ScriptOutcome {
        var result: ScriptOutcome = .failure("script did not run")
        let work = {
            guard let script = NSAppleScript(source: source) else {
                result = .failure("could not compile script")
                return
            }
            var error: NSDictionary?
            let value = script.executeAndReturnError(&error)
            if let error {
                result = .failure((error[NSAppleScript.errorMessage] as? String) ?? "\(error)")
            } else {
                result = .success(value.stringValue ?? "")
            }
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
        return result
    }

    /// Run browser work without leaving Chrome in front. Chrome raises itself on
    /// window creation and on tab changes, so every browser tool restores the
    /// app the user was in and pushes the agent window back down the stack.
    static func preservingFocus<T>(_ body: () -> T) -> T {
        let previous = NSWorkspace.shared.frontmostApplication
        let previousWindow = frontWindowID()
        let result = body()
        if let previousWindow, previousWindow != agentWindowID {
            raiseWindow(previousWindow)
        }
        if let previous,
           previous.processIdentifier != NSWorkspace.shared.frontmostApplication?.processIdentifier {
            DispatchQueue.main.sync { previous.activate(options: []) }
            usleep(220_000)
        }
        return result
    }

    /// Chrome's scripting `index` property does not actually reorder windows, so
    /// the user's window is brought back to the front with the accessibility
    /// raise action instead. That reorders within Chrome without activating it.
    static func raiseWindow(_ id: Int) {
        guard let frame = boundsOf(id), let match = axWindow(matching: frame) else { return }
        AXUIElementPerformAction(match.element, kAXRaiseAction as CFString)
    }

    static func frontWindowID() -> Int? {
        guard case .success(let s) = run("""
        tell application "Google Chrome"
            if (count windows) is 0 then return ""
            return (id of window 1) as string
        end tell
        """) else { return nil }
        return Int(s.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines))
    }

    static func windowExists(_ id: Int) -> Bool {
        if case .success(let s) = run("""
        tell application "Google Chrome" to return (exists window id \(id)) as string
        """) { return s == "true" }
        return false
    }

    /// Return the agent's window id, creating the window if needed.
    static func ensureAgentWindow() -> WindowOutcome {
        if let id = liveAgentWindowID() { return .success(id) }

        let created = run("""
        tell application "Google Chrome"
            set w to make new window
            return id of w as string
        end tell
        """)
        switch created {
        case .failure(let e): return .failure(e)
        case .success(let s):
            guard let id = Int(s.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)) else {
                return .failure("unexpected window id: \(s)")
            }
            agentWindowID = id
            return .success(id)
        }
    }

    /// Screen frame of the agent window, used to pair it with its AX window.
    static func agentWindowFrame() -> CGRect? {
        guard let id = liveAgentWindowID() else { return nil }
        return boundsOf(id)
    }

    static func boundsOf(_ id: Int) -> CGRect? {
        guard case .success(let s) = run("""
        tell application "Google Chrome"
            set b to bounds of window id \(id)
            return ((item 1 of b) as string) & "," & ((item 2 of b) as string) & "," ¬
                & ((item 3 of b) as string) & "," & ((item 4 of b) as string)
        end tell
        """) else { return nil }
        let parts = s.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: CharacterSet.whitespaces)) }
        guard parts.count == 4 else { return nil }
        return CGRect(x: parts[0], y: parts[1], width: parts[2] - parts[0], height: parts[3] - parts[1])
    }

    /// The AX window for the agent's Chrome window.
    ///
    /// Chrome's scripting ids and accessibility elements are separate worlds with
    /// no shared handle, so they are paired by screen position — the closest
    /// origin wins, which is unambiguous unless two windows are exactly stacked.
    static func agentAXWindow() -> (element: AXUIElement, pid: pid_t)? {
        guard let frame = agentWindowFrame() else { return nil }
        return axWindow(matching: frame)
    }

    /// Pair a scripting window with its accessibility element by screen frame.
    /// Chrome cascades new windows only ~28px apart, so origin alone is not
    /// enough to tell them apart — size is folded into the distance and the
    /// tolerance is tight.
    static func axWindow(matching frame: CGRect) -> (element: AXUIElement, pid: pid_t)? {
        var best: (AXUIElement, pid_t, CGFloat)?
        for app in NSWorkspace.shared.runningApplications
        where app.bundleIdentifier == "com.google.Chrome" {
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            for window in (axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] {
                guard let origin = axPoint(window, kAXPositionAttribute as String),
                      let size = axSize(window, kAXSizeAttribute as String) else { continue }
                let distance = hypot(origin.x - frame.origin.x, origin.y - frame.origin.y)
                    + hypot(size.width - frame.width, size.height - frame.height)
                if best == nil || distance < best!.2 {
                    best = (window, app.processIdentifier, distance)
                }
            }
        }
        guard let best, best.2 < 12 else { return nil }
        return (best.0, best.1)
    }
}

func toolBrowserOpenTab(_ args: [String: Any]) -> String {
    let url = (args["url"] as? String) ?? "about:blank"
    // The extension is the good path: it opens an inactive tab in a labelled
    // group inside the user's own signed-in Chrome. Without it, fall back to a
    // separate window driven through the accessibility API.
    if BrowserBridge.shared.isConnected {
        return bridgeText(BrowserBridge.shared.call("open_tab", ["url": url])) { payload in
            "opened \(url) in the agent tab group (tab_id=\(payload["tabId"] as? Int ?? -1))"
        }
    }
    return Chrome.preservingFocus {
        switch Chrome.ensureAgentWindow() {
        case .failure(let e):
            return "error: could not open the agent window: \(e)"
        case .success(let id):
            let escaped = url.replacingOccurrences(of: "\"", with: "\\\"")
            switch Chrome.run("""
            tell application "Google Chrome"
                set w to window id \(id)
                make new tab at end of tabs of w with properties {URL:"\(escaped)"}
                set active tab index of w to (count tabs of w)
                return ((count tabs of w) as string)
            end tell
            """) {
            case .failure(let e):
                return "error: \(e)"
            case .success(let count):
                let n = count.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
                return "opened \(url) as tab \(n) in the agent window (id \(id))"
            }
        }
    }
}

func toolBrowserListTabs(_ args: [String: Any]) -> String {
    if BrowserBridge.shared.isConnected {
        return bridgeText(BrowserBridge.shared.call("list_tabs"), describeTabs)
    }
    guard let id = Chrome.liveAgentWindowID() else {
        return "no agent window yet — call browser_open_tab first"
    }
    return Chrome.preservingFocus {
        switch Chrome.run("""
        tell application "Google Chrome"
            set w to window id \(id)
            set activeIndex to active tab index of w
            set out to ""
            repeat with i from 1 to (count tabs of w)
                set t to tab i of w
                set marker to "  "
                if i is activeIndex then set marker to "* "
                set out to out & marker & (i as string) & ". " & (title of t) & "  [" & (URL of t) & "]" & linefeed
            end repeat
            return out
        end tell
        """) {
        case .failure(let e):
            return "error: \(e)"
        case .success(let s):
            return "agent window \(id) (* = active):\n" + (s.isEmpty ? "  (no tabs)" : s)
        }
    }
}

func toolBrowserSelectTab(_ args: [String: Any]) -> String {
    if BrowserBridge.shared.isConnected {
        guard let tabId = args["tab_id"] as? Int ?? args["index"] as? Int else {
            return "error: missing required argument 'tab_id'"
        }
        return bridgeText(BrowserBridge.shared.call("select_tab", ["tabId": tabId])) { _ in
            "switched the agent group to tab \(tabId)"
        }
    }
    guard let index = args["index"] as? Int else { return "error: missing required argument 'index'" }
    guard let id = Chrome.liveAgentWindowID() else {
        return "error: no agent window yet — call browser_open_tab first"
    }
    return Chrome.preservingFocus {
        switch Chrome.run("""
        tell application "Google Chrome"
            set w to window id \(id)
            if \(index) < 1 or \(index) > (count tabs of w) then return "out of range"
            set active tab index of w to \(index)
            return title of active tab of w
        end tell
        """) {
        case .failure(let e):
            return "error: \(e)"
        case .success(let title):
            return title == "out of range"
                ? "error: tab \(index) is out of range for the agent window"
                : "switched the agent window to tab \(index): \(title)"
        }
    }
}

func toolBrowserCloseTab(_ args: [String: Any]) -> String {
    if BrowserBridge.shared.isConnected {
        guard let tabId = args["tab_id"] as? Int ?? args["index"] as? Int else {
            return "error: missing required argument 'tab_id'"
        }
        return bridgeText(BrowserBridge.shared.call("close_tab", ["tabId": tabId])) { _ in
            "closed tab \(tabId)"
        }
    }
    guard let index = args["index"] as? Int else { return "error: missing required argument 'index'" }
    guard let id = Chrome.liveAgentWindowID() else {
        return "error: no agent window yet"
    }
    return Chrome.preservingFocus {
        switch Chrome.run("""
        tell application "Google Chrome"
            set w to window id \(id)
            if \(index) < 1 or \(index) > (count tabs of w) then return "out of range"
            close tab \(index) of w
            return "ok"
        end tell
        """) {
        case .failure(let e):
            return "error: \(e)"
        case .success(let s):
            return s == "out of range" ? "error: tab \(index) is out of range" : "closed tab \(index)"
        }
    }
}


// MARK: - Browser tools over the extension

/// Render a bridge reply as tool text, or the failure as an error line.
func bridgeText(_ result: BridgeOutcome, _ describe: ([String: Any]) -> String) -> String {
    switch result {
    case .failure(let message): return "error: \(message)"
    case .success(let payload): return describe(payload)
    }
}

func toolBrowserSnapshot(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    return bridgeText(BrowserBridge.shared.call("snapshot", ["tabId": tabId])) { payload in
        let elements = payload["elements"] as? [[String: Any]] ?? []
        var lines = ["\(payload["title"] as? String ?? "?")  [\(payload["url"] as? String ?? "")]"]
        for element in elements {
            let index = element["i"] as? Int ?? -1
            let tag = element["tag"] as? String ?? "?"
            let label = element["label"] as? String ?? ""
            let offscreen = (element["inView"] as? Bool == false) ? "  (scrolled out of view)" : ""
            lines.append("  [\(index)] \(tag)\(label.isEmpty ? "" : " \"\(label)\"")\(offscreen)")
        }
        return lines.joined(separator: "\n")
    }
}

func toolBrowserClick(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    var params: [String: Any] = ["tabId": tabId]
    if let index = args["index"] as? Int {
        params["index"] = index
    } else if let x = args["x"] as? Double, let y = args["y"] as? Double {
        params["x"] = x
        params["y"] = y
    } else {
        return "error: provide either index (from browser_snapshot), or both x and y"
    }
    return bridgeText(BrowserBridge.shared.call("click", params)) { _ in
        "clicked in tab \(tabId)"
    }
}

func toolBrowserType(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    guard let text = args["text"] as? String else { return "error: missing required argument 'text'" }
    return bridgeText(BrowserBridge.shared.call("type", ["tabId": tabId, "text": text])) { _ in
        "typed \(text.count) characters into tab \(tabId)"
    }
}

func toolBrowserPressKey(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    guard let key = args["key"] as? String else { return "error: missing required argument 'key'" }
    return bridgeText(BrowserBridge.shared.call("press", ["tabId": tabId, "key": key])) { _ in
        "pressed \(key) in tab \(tabId)"
    }
}

func toolBrowserCloseAllTabs(_ args: [String: Any]) -> String {
    guard BrowserBridge.shared.isConnected else {
        return "error: the T3 Code Chrome extension is not connected"
    }
    return bridgeText(BrowserBridge.shared.call("close_all_tabs")) { payload in
        let closed = payload["closed"] as? Int ?? 0
        return closed == 0
            ? "nothing to clean up — the agent had no tabs open"
            : "closed \(closed) agent tab\(closed == 1 ? "" : "s") and removed the tab group"
    }
}

func toolBrowserNavigate(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    guard let url = args["url"] as? String else { return "error: missing required argument 'url'" }
    return bridgeText(BrowserBridge.shared.call("navigate", ["tabId": tabId, "url": url])) { _ in
        "navigated tab \(tabId) to \(url)"
    }
}

func describeTabs(_ payload: [String: Any]) -> String {
    let tabs = payload["tabs"] as? [[String: Any]] ?? []
    if tabs.isEmpty { return "the agent has no tabs open yet — call browser_open_tab" }
    var lines = ["agent tab group (\(tabs.count) tab\(tabs.count == 1 ? "" : "s")):"]
    for tab in tabs {
        let marker = (tab["active"] as? Bool == true) ? "* " : "  "
        lines.append("\(marker)tab_id=\(tab["tabId"] as? Int ?? -1)  \(tab["title"] as? String ?? "")"
            + "  [\(tab["url"] as? String ?? "")]")
    }
    return lines.joined(separator: "\n")
}

// MARK: - Tool schemas

func obj(_ d: [String: Any]) -> [String: Any] { d }

let toolDefs: [[String: Any]] = [
    [
        "name": "list_apps",
        "description": "List running applications with their bundle id, pid, window count, and which is frontmost. Note that one app can have several running instances and only some may own windows.",
        "inputSchema": ["type": "object", "properties": [:] as [String: Any]],
    ],
    [
        "name": "get_app_state",
        "description": "Read an app's accessibility tree as an indented outline. Interactive elements are prefixed with an id like [e12] that you pass to click/type_text/scroll. Call this before interacting, and again after the UI changes, since ids are per-snapshot.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "app": ["type": "string", "description": "App name, bundle id, or pid"],
                "max_depth": ["type": "integer", "description": "Max tree depth (default 18)"],
                "max_elements": ["type": "integer", "description": "Max elements to emit (default 800)"],
                "window": ["description": "Limit to one window: a 0-based index, or \"agent\" for the browser window this agent owns"],
            ],
            "required": ["app"],
        ],
    ],
    [
        "name": "click",
        "description": "Click an element by element_id (preferred, uses the accessibility press action) or at absolute screen coordinates.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "element_id": ["type": "string", "description": "Element id from get_app_state, e.g. e12"],
                "x": ["type": "number"], "y": ["type": "number"],
                "click_count": ["type": "integer", "description": "1 for single, 2 for double-click"],
            ],
        ],
    ],
    [
        "name": "type_text",
        "description": "Type literal text into the focused element, optionally focusing element_id first.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "text": ["type": "string"],
                "element_id": ["type": "string", "description": "Focus this element before typing"],
            ],
            "required": ["text"],
        ],
    ],
    [
        "name": "press_key",
        "description": "Press a named key with optional modifiers, e.g. key='s' modifiers=['cmd'] to save, or key='return'.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "key": ["type": "string"],
                "modifiers": ["type": "array", "items": ["type": "string"],
                              "description": "Any of cmd, shift, alt, ctrl, fn"],
            ],
            "required": ["key"],
        ],
    ],
    [
        "name": "scroll",
        "description": "Scroll up, down, left, or right, optionally positioning the cursor over element_id first.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "direction": ["type": "string", "enum": ["up", "down", "left", "right"]],
                "amount": ["type": "integer", "description": "Scroll lines (default 5)"],
                "element_id": ["type": "string"],
            ],
        ],
    ],
    [
        "name": "activate_app",
        "description": "Bring an app to the foreground.",
        "inputSchema": [
            "type": "object",
            "properties": ["app": ["type": "string"]],
            "required": ["app"],
        ],
    ],
    [
        "name": "screenshot",
        "description": "Capture the app's largest window as a PNG image. Prefer get_app_state for interaction, which is cheaper and gives clickable element ids; use a screenshot when you need to see rendered content the accessibility tree does not describe, such as canvas or video.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "app": ["type": "string", "description": "App name, bundle id, or pid"],
                "display": ["type": "integer", "description": "Capture a whole display by index (see list_displays) instead of an app window"],
                "max_width": ["type": "integer", "description": "Downscale to this width in pixels (default 1400)"],
            ],
        ],
    ],
    [
        "name": "list_displays",
        "description": "List every attached display with its index, resolution and position, for use with screenshot(display: N).",
        "inputSchema": ["type": "object", "properties": [:] as [String: Any]],
    ],
    [
        "name": "right_click",
        "description": "Right-click (secondary click) an element or screen position to open a context menu.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "element_id": ["type": "string"],
                "x": ["type": "number"], "y": ["type": "number"],
            ],
        ],
    ],
    [
        "name": "drag",
        "description": "Press at one point, drag, and release at another. Accepts element ids or coordinates on each end.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "from_element_id": ["type": "string"], "to_element_id": ["type": "string"],
                "from_x": ["type": "number"], "from_y": ["type": "number"],
                "to_x": ["type": "number"], "to_y": ["type": "number"],
            ],
        ],
    ],
    [
        "name": "set_value",
        "description": "Replace a text field's contents directly. More reliable than select-all-then-type for long values, though some fields reject it and need click + type_text.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "element_id": ["type": "string"],
                "value": ["type": "string"],
            ],
            "required": ["element_id", "value"],
        ],
    ],
    [
        "name": "browser_open_tab",
        "description": "Open a URL in a new background tab inside the agent's own labelled tab group, in the user's signed-in Chrome. The user keeps browsing their tabs undisturbed. Returns a tab_id for browser_snapshot / browser_click.",
        "inputSchema": [
            "type": "object",
            "properties": ["url": ["type": "string", "description": "URL to open (default about:blank)"]],
        ],
    ],
    [
        "name": "browser_list_tabs",
        "description": "List the tabs in the agent's own Chrome window, marking the active one.",
        "inputSchema": ["type": "object", "properties": [:] as [String: Any]],
    ],
    [
        "name": "browser_select_tab",
        "description": "Make one of the agent's tabs the visible one. Does not affect the user's tabs.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": ["type": "integer", "description": "From browser_list_tabs"],
                "index": ["type": "integer", "description": "1-based index, fallback mode only"],
            ],
        ],
    ],
    [
        "name": "browser_close_tab",
        "description": "Close one of the agent's tabs.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": ["type": "integer", "description": "From browser_list_tabs"],
                "index": ["type": "integer", "description": "1-based index, fallback mode only"],
            ],
        ],
    ],
    [
        "name": "browser_snapshot",
        "description": "List the interactive elements on a page in one of the agent's tabs, with indices to pass to browser_click. Works on a background tab, so the user can be looking at something else.",
        "inputSchema": [
            "type": "object",
            "properties": ["tab_id": ["type": "integer", "description": "From browser_open_tab or browser_list_tabs"]],
            "required": ["tab_id"],
        ],
    ],
    [
        "name": "browser_click",
        "description": "Click in one of the agent's tabs, by element index from browser_snapshot or by page coordinates. Works on a background tab.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": ["type": "integer"],
                "index": ["type": "integer", "description": "Element index from browser_snapshot"],
                "x": ["type": "number"], "y": ["type": "number"],
            ],
            "required": ["tab_id"],
        ],
    ],
    [
        "name": "browser_type",
        "description": "Type text into the focused field of one of the agent's tabs. Click the field first.",
        "inputSchema": [
            "type": "object",
            "properties": ["tab_id": ["type": "integer"], "text": ["type": "string"]],
            "required": ["tab_id", "text"],
        ],
    ],
    [
        "name": "browser_press_key",
        "description": "Press Enter, Tab, Escape or Backspace in one of the agent's tabs.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": ["type": "integer"],
                "key": ["type": "string", "enum": ["Enter", "Tab", "Escape", "Backspace"]],
            ],
            "required": ["tab_id", "key"],
        ],
    ],
    [
        "name": "browser_close_all_tabs",
        "description": "Close every tab the agent opened and remove its tab group. Call this when finished with the browser so no empty group is left in the user's tab strip.",
        "inputSchema": ["type": "object", "properties": [:] as [String: Any]],
    ],
    [
        "name": "browser_navigate",
        "description": "Point one of the agent's tabs at a different URL.",
        "inputSchema": [
            "type": "object",
            "properties": ["tab_id": ["type": "integer"], "url": ["type": "string"]],
            "required": ["tab_id", "url"],
        ],
    ],
    [
        "name": "select_text",
        "description": "Select a character range inside a text element. Defaults to selecting from 'start' to the end of the value.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "element_id": ["type": "string"],
                "start": ["type": "integer", "description": "Start offset (default 0)"],
                "length": ["type": "integer", "description": "Characters to select (default: to end)"],
            ],
            "required": ["element_id"],
        ],
    ],
]

func dispatch(_ name: String, _ args: [String: Any]) -> String {
    switch name {
    case "list_apps": return toolListApps()
    case "get_app_state": return toolGetAppState(args)
    case "click": return toolClick(args)
    case "type_text": return toolTypeText(args)
    case "press_key": return toolPressKey(args)
    case "scroll": return toolScroll(args)
    case "activate_app": return toolActivateApp(args)
    case "list_displays": return toolListDisplays(args)
    case "right_click": return toolRightClick(args)
    case "drag": return toolDrag(args)
    case "set_value": return toolSetValue(args)
    case "select_text": return toolSelectText(args)
    case "browser_open_tab": return toolBrowserOpenTab(args)
    case "browser_list_tabs": return toolBrowserListTabs(args)
    case "browser_select_tab": return toolBrowserSelectTab(args)
    case "browser_close_tab": return toolBrowserCloseTab(args)
    case "browser_snapshot": return toolBrowserSnapshot(args)
    case "browser_click": return toolBrowserClick(args)
    case "browser_type": return toolBrowserType(args)
    case "browser_press_key": return toolBrowserPressKey(args)
    case "browser_navigate": return toolBrowserNavigate(args)
    case "browser_close_all_tabs": return toolBrowserCloseAllTabs(args)
    default: return "error: unknown tool \(name)"
    }
}

// MARK: - Agent cursor overlay
//
// A second cursor, so the user can see where the agent is working. It is a
// borderless non-activating panel that ignores mouse events, so it floats above
// everything without stealing clicks or focus, and it never appears in the
// per-window screenshots the agent takes of other apps.
//
// The look is deliberately a soft translucent bubble rather than a pointer: the
// agent's cursor should never be mistaken for the user's own. It moves on a
// spring, squashes along its direction of travel, and pops on click.

final class CursorOverlay {
    static let shared = CursorOverlay()

    /// Generous panel so the glow, squash and click ripple all have room.
    private let side: CGFloat = 96
    /// Distance from the panel's top-left corner to the cursor's hot point.
    fileprivate static let hotspot: CGFloat = 48

    private var panel: NSPanel?
    private var view: BubbleView?
    private var animation: Timer?
    private var hideWork: DispatchWorkItem?

    /// Spring state, in Quartz screen coordinates.
    private var current: CGPoint?
    private var target: CGPoint = .zero
    private var velocity: CGVector = .zero

    private let enabled = ProcessInfo.processInfo.environment["T3_DESKTOP_MCP_OVERLAY"] != "0"

    // MARK: Drawing

    private final class BubbleView: NSView {
        /// 0…1 while a click ripple plays, nil otherwise.
        var ripple: CGFloat?
        /// 0…1 while the bubble pops on click, nil otherwise.
        var pop: CGFloat?
        /// Slow idle breathing so a resting cursor still reads as alive.
        var phase: CGFloat = 0
        /// Current travel, used for squash-and-stretch.
        var velocity: CGVector = .zero
        /// Lean, in radians. Banks into the direction of travel and eases back
        /// to upright when the cursor settles.
        var tilt: CGFloat = 0
        /// Jelly wobble: amplitude builds with speed and decays after the
        /// bubble stops, so it keeps jiggling for a moment on arrival.
        var wobble: CGFloat = 0
        var wobblePhase: CGFloat = 0

        private var accent: NSColor { NSColor.controlAccentColor }

        override func draw(_ dirtyRect: NSRect) {
            guard let ctx = NSGraphicsContext.current?.cgContext else { return }
            let tip = CGPoint(x: CursorOverlay.hotspot, y: bounds.maxY - CursorOverlay.hotspot)

            // Ripple on click, drawn under everything else.
            if let ripple {
                let eased = 1 - pow(1 - ripple, 3)
                let r = 13 + eased * 20
                ctx.setStrokeColor(NSColor.white.withAlphaComponent((1 - eased) * 0.4).cgColor)
                ctx.setLineWidth(2.5 * (1 - eased) + 0.5)
                ctx.strokeEllipse(in: CGRect(x: tip.x - r, y: tip.y - r, width: r * 2, height: r * 2))
            }

            // Wide, very diffuse lavender wash. No hard edge anywhere: the glow
            // should fade out rather than read as a disc behind the arrow.
            let lavender = NSColor(calibratedRed: 0.74, green: 0.73, blue: 0.93, alpha: 1)
            let breathe = 1 + 0.03 * sin(phase)
            let glowR: CGFloat = 34 * breathe
            if let wash = CGGradient(
                colorsSpace: CGColorSpaceCreateDeviceRGB(),
                colors: [lavender.withAlphaComponent(0.55).cgColor,
                         lavender.withAlphaComponent(0.34).cgColor,
                         lavender.withAlphaComponent(0.12).cgColor,
                         lavender.withAlphaComponent(0).cgColor] as CFArray,
                locations: [0, 0.35, 0.68, 1]) {
                ctx.drawRadialGradient(wash, startCenter: tip, startRadius: 0,
                                       endCenter: tip, endRadius: glowR, options: [])
            }

            ctx.saveGState()
            ctx.translateBy(x: tip.x, y: tip.y)
            let travelX = abs(velocity.dx), travelY = abs(velocity.dy)
            let wobbleAmount = 0.15 * wobble * sin(wobblePhase)
            var popScale: CGFloat = 1
            if let pop { popScale = 1 + 0.22 * sin(pop * .pi * 2) * (1 - pop) }
            ctx.rotate(by: tilt)
            ctx.scaleBy(x: (1 + travelX / 260 - travelY / 520 + wobbleAmount) * popScale,
                        y: (1 + travelY / 260 - travelX / 520 - wobbleAmount) * popScale)

            // Four points — tip, right shoulder, an inward notch, then the
            // tail — with each corner replaced by a tangent arc. Relying on the
            // stroke's round join alone leaves the outer silhouette pointy;
            // rounding the path itself is what gives the soft pebble shape.
            let corners = [
                NSPoint(x: 0, y: 0),
                NSPoint(x: 22.5, y: -10.5),
                NSPoint(x: 13.5, y: -16),
                NSPoint(x: 6.5, y: -26),
            ]
            let radius: CGFloat = 2.1
            let arrow = NSBezierPath()
            func midpoint(_ a: NSPoint, _ b: NSPoint) -> NSPoint {
                NSPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
            }
            arrow.move(to: midpoint(corners[corners.count - 1], corners[0]))
            for i in 0..<corners.count {
                arrow.appendArc(from: corners[i], to: corners[(i + 1) % corners.count],
                                radius: radius)
            }
            arrow.close()
            arrow.lineJoinStyle = .round
            arrow.lineCapStyle = .round

            // Gradient interior: deeper slate at the tail, lighter toward the
            // shoulder, so the shape has depth instead of reading as a hole.
            ctx.saveGState()
            arrow.addClip()
            let deep = NSColor(calibratedRed: 0.40, green: 0.40, blue: 0.56, alpha: 0.92)
            let light = NSColor(calibratedRed: 0.60, green: 0.60, blue: 0.75, alpha: 0.92)
            if let fill = NSGradient(starting: deep, ending: light) {
                fill.draw(in: arrow.bounds, angle: 35)
            }
            ctx.restoreGState()

            // Thick near-white rim with a soft bloom behind it.
            ctx.saveGState()
            ctx.setShadow(offset: .zero, blur: 7,
                          color: NSColor.white.withAlphaComponent(0.55).cgColor)
            arrow.lineWidth = 3.1
            NSColor(calibratedWhite: 0.97, alpha: 1).setStroke()
            arrow.stroke()
            ctx.restoreGState()

            ctx.restoreGState()
        }
    }

    // MARK: API

    /// Move the agent cursor to a Quartz screen point.
    func show(at point: CGPoint) { schedule(point, popping: false) }

    /// Move and play the click pop + ripple.
    func press(at point: CGPoint) { schedule(point, popping: true) }

    private func schedule(_ point: CGPoint, popping: Bool) {
        guard enabled else { return }
        DispatchQueue.main.async { self.begin(point, popping: popping) }
    }

    private func begin(_ point: CGPoint, popping: Bool) {
        let panel = ensurePanel()
        target = point
        // A first appearance should not fly in from a stale position.
        if current == nil || !panel.isVisible {
            current = point
            velocity = .zero
        }
        place(current ?? point)

        if !panel.isVisible {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.14
                panel.animator().alphaValue = 1
            }
        }
        if popping {
            view?.ripple = 0
            view?.pop = 0
            view?.wobble = max(view?.wobble ?? 0, 0.9)
        }

        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.fadeOut() }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.9, execute: work)
        startAnimating()
    }

    private func startAnimating() {
        guard animation == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        animation = timer
    }

    private func tick() {
        guard let view else { return }
        var busy = false

        if var cur = current {
            // Spring toward the target: stiffness pulls, damping keeps the
            // overshoot to a gentle bounce rather than a wobble.
            let dx = target.x - cur.x, dy = target.y - cur.y
            velocity.dx = (velocity.dx + dx * 0.34) * 0.62
            velocity.dy = (velocity.dy + dy * 0.34) * 0.62
            if abs(dx) < 0.3, abs(dy) < 0.3, abs(velocity.dx) < 0.3, abs(velocity.dy) < 0.3 {
                cur = target
                velocity = .zero
            } else {
                cur.x += velocity.dx
                cur.y += velocity.dy
                busy = true
            }
            current = cur
            view.velocity = velocity
            let speed = sqrt(velocity.dx * velocity.dx + velocity.dy * velocity.dy)
            view.wobble = max(view.wobble * 0.88, min(speed / 26, 1.15))
            view.wobblePhase += 0.78

            // Bank into the travel: leaning is driven mostly by horizontal
            // speed, with a little from vertical, and it eases back to upright
            // once the cursor stops rather than snapping.
            let targetTilt = max(-0.42, min(0.42, -velocity.dx * 0.011 + velocity.dy * 0.004))
            view.tilt += (targetTilt - view.tilt) * 0.16
            if abs(view.tilt) > 0.004 { busy = true } else { view.tilt = 0 }

            place(cur)
        }

        if let r = view.ripple {
            let next = r + (1.0 / 60.0) / 0.5
            view.ripple = next >= 1 ? nil : next
            busy = true
        }
        if let p = view.pop {
            let next = p + (1.0 / 60.0) / 0.36
            view.pop = next >= 1 ? nil : next
            busy = true
        }

        if view.wobble > 0.01 { busy = true } else { view.wobble = 0 }
        view.phase += 0.08
        view.needsDisplay = true

        if !busy, panel?.isVisible != true {
            animation?.invalidate()
            animation = nil
        }
    }

    private func place(_ point: CGPoint) {
        guard let panel, let mainScreen = NSScreen.screens.first else { return }
        // Quartz measures y downward from the top of the main display; AppKit
        // measures it upward from the bottom.
        let flippedY = mainScreen.frame.maxY - point.y
        panel.setFrameOrigin(NSPoint(x: point.x - CursorOverlay.hotspot,
                                     y: flippedY - side + CursorOverlay.hotspot))
    }

    private func fadeOut() {
        guard let panel, panel.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.25
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self else { return }
            if panel.alphaValue < 0.05 {
                panel.orderOut(nil)
                self.animation?.invalidate()
                self.animation = nil
            }
        })
    }

    private func ensurePanel() -> NSPanel {
        if let panel { return panel }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: side, height: side),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        let view = BubbleView(frame: NSRect(x: 0, y: 0, width: side, height: side))
        panel.contentView = view
        self.panel = panel
        self.view = view
        return panel
    }
}

// MARK: - JSON-RPC over stdio

func send(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func respond(id: Any, result: [String: Any]) {
    send(["jsonrpc": "2.0", "id": id, "result": result])
}

func respondError(id: Any, code: Int, message: String) {
    send(["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]])
}

func textResult(_ s: String, isError: Bool = false) -> [String: Any] {
    ["content": [["type": "text", "text": s]], "isError": isError]
}

// Chrome launches this same binary as its native messaging host; in that mode
// it is a relay, not an MCP server.
if CommandLine.arguments.contains("native-host") { NativeHost.run() }
if CommandLine.arguments.contains("cursor-overlay") { AgentCursorOverlay.run() }

BrowserBridge.shared.start()

// ScreenCaptureKit talks to the window server, which asserts (did_initialize)
// unless the process has been initialised as a GUI app. `.accessory` keeps it
// out of the Dock and app switcher while still allowing the cursor overlay
// panel; `.prohibited` would forbid windows entirely.
_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)

setvbuf(stdout, nil, _IOLBF, 0)

// The JSON-RPC loop blocks on readLine, so it cannot own the main thread: AppKit
// needs the main run loop to draw the overlay. Requests are handled on a
// background queue and UI work hops back to main.
func runJSONRPCLoop() {
while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: CharacterSet.whitespaces).isEmpty { continue }
    guard let data = line.data(using: .utf8),
          let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let method = msg["method"] as? String else { continue }

    let id = msg["id"]

    switch method {
    case "initialize":
        respond(id: id ?? NSNull(), result: [
            "protocolVersion": "2024-11-05",
            "capabilities": ["tools": ["listChanged": false]],
            "serverInfo": ["name": "t3-desktop", "version": "0.1.0"],
        ])

    case "tools/list":
        respond(id: id ?? NSNull(), result: ["tools": toolDefs])

    case "tools/call":
        guard let id else { continue }
        let params = msg["params"] as? [String: Any] ?? [:]
        guard let name = params["name"] as? String else {
            respondError(id: id, code: -32602, message: "missing tool name")
            continue
        }
        let args = params["arguments"] as? [String: Any] ?? [:]

        // Handled ahead of the Accessibility check: screen capture is gated by
        // Screen Recording, a separate permission, so screenshots should still
        // work if only that one is granted.
        if name == "screenshot" {
            if let display = args["display"] as? Int {
                let maxWidth = (args["max_width"] as? Int) ?? 1400
                guard let shot = captureDisplayPNG(index: display, maxWidth: maxWidth) else {
                    respond(id: id, result: textResult(
                        "error: could not capture display \(display) — check Screen Recording "
                        + "permission, or call list_displays for valid indices.", isError: true))
                    continue
                }
                respond(id: id, result: [
                    "content": [[
                        "type": "image", "data": shot.data.base64EncodedString(),
                        "mimeType": "image/png",
                    ]],
                    "isError": false,
                ])
                continue
            }
            guard let query = args["app"] as? String, let resolved = resolveApp(query) else {
                respond(id: id, result: textResult(
                    "error: no running app matching \(args["app"] as? String ?? "<missing app argument>")",
                    isError: true))
                continue
            }
            let maxWidth = (args["max_width"] as? Int) ?? 1400
            guard let png = captureWindowPNG(pid: resolved.app.processIdentifier, maxWidth: maxWidth) else {
                respond(id: id, result: textResult(
                    "error: screen capture failed. The host app may be missing Screen Recording "
                    + "permission, or this app may have no on-screen window.",
                    isError: true))
                continue
            }
            respond(id: id, result: [
                "content": [[
                    "type": "image",
                    "data": png.base64EncodedString(),
                    "mimeType": "image/png",
                ]],
                "isError": false,
            ])
            continue
        }

        if !AXIsProcessTrusted() {
            respond(id: id, result: textResult(
                "Accessibility permission is not granted to the host app. Enable it in "
                + "System Settings → Privacy & Security → Accessibility, then restart the app.",
                isError: true))
            continue
        }
        let out = dispatch(name, args)
        respond(id: id, result: textResult(out, isError: out.hasPrefix("error:")))

    case "ping":
        respond(id: id ?? NSNull(), result: [:])

    default:
        // Notifications carry no id and require no reply.
        if let id { respondError(id: id, code: -32601, message: "method not found: \(method)") }
    }
}
    // stdin closed: the client is gone, so the process should follow.
    exit(0)
}

DispatchQueue.global(qos: .userInitiated).async { runJSONRPCLoop() }
NSApp.run()
