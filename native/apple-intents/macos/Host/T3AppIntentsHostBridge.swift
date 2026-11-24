import Foundation
import T3IntentsCore

/// C ABI loaded into the Electron main process via `ffi-rs` so CoreSpotlight indexing and
/// onscreen `NSUserActivity.appEntityIdentifier` execute under `Bundle.main == T3 Code.app`.

private func runBlockingAsync(_ work: @escaping @Sendable () async throws -> Void) -> Int32 {
  final class ResultBox: @unchecked Sendable {
    var code: Int32 = 0
  }
  let box = ResultBox()
  let semaphore = DispatchSemaphore(value: 0)
  Task.detached(priority: .utility) {
    do {
      try await work()
    } catch {
      box.code = 1
    }
    semaphore.signal()
  }
  // Spotlight work carries its own deadline; this outer bound guarantees the ffi-rs worker thread
  // is always released even if something else stalls.
  guard semaphore.wait(timeout: .now() + hostCallDeadline) == .success else { return 3 }
  return box.code
}

private let hostCallDeadline: DispatchTimeInterval = .seconds(50)

@_cdecl("t3_apple_intents_is_supported")
public func t3_apple_intents_is_supported() -> Int32 {
  T3IntentsRuntime.isSupportedOS ? 1 : 0
}

@_cdecl("t3_apple_intents_bootstrap")
public func t3_apple_intents_bootstrap() -> Int32 {
  T3IntentsRuntime.shared.bootstrap()
  return 0
}

@_cdecl("t3_apple_intents_sync_index")
public func t3_apple_intents_sync_index(_ jsonPtr: UnsafePointer<CChar>?) -> Int32 {
  guard let jsonPtr else { return 2 }
  let json = String(cString: jsonPtr)
  return runBlockingAsync {
    try await T3IntentsRuntime.shared.syncIndexJSON(json)
  }
}

@_cdecl("t3_apple_intents_remove_environment")
public func t3_apple_intents_remove_environment(_ envIdPtr: UnsafePointer<CChar>?) -> Int32 {
  guard let envIdPtr else { return 2 }
  let envId = String(cString: envIdPtr)
  return runBlockingAsync {
    try await T3IntentsRuntime.shared.removeEnvironment(environmentId: envId)
  }
}

@_cdecl("t3_apple_intents_clear_index")
public func t3_apple_intents_clear_index() -> Int32 {
  runBlockingAsync {
    try await T3IntentsRuntime.shared.clearIndex()
  }
}

@_cdecl("t3_apple_intents_set_onscreen_context")
public func t3_apple_intents_set_onscreen_context(_ jsonPtr: UnsafePointer<CChar>?) -> Int32 {
  let json = jsonPtr.map { String(cString: $0) }
  let normalized = (json?.isEmpty ?? true) ? nil : json
  T3IntentsRuntime.shared.setOnscreenContextJSON(normalized)
  return 0
}

@_cdecl("t3_apple_intents_sync_auth_credentials")
public func t3_apple_intents_sync_auth_credentials(_ jsonPtr: UnsafePointer<CChar>?) -> Int32 {
  guard let jsonPtr else { return 2 }
  let json = String(cString: jsonPtr)
  do {
    try T3IntentsRuntime.shared.syncAuthCredentialsJSON(json)
    return 0
  } catch {
    return 1
  }
}

private let resolvedURLLock = NSLock()
nonisolated(unsafe) private var lastResolvedURL: UnsafeMutablePointer<CChar>?

/// Returns a string the dylib owns until the next call, never null ("" when unresolved). ffi-rs
/// copies it into a JS string before returning, and only Electron's main thread calls this, so the
/// caller never frees anything.
@_cdecl("t3_apple_intents_resolve_spotlight_url")
public func t3_apple_intents_resolve_spotlight_url(
  _ identifierPtr: UnsafePointer<CChar>?
) -> UnsafePointer<CChar>? {
  let url = identifierPtr
    .flatMap { T3IntentsRuntime.shared.resolveDeepLink(forSpotlightIdentifier: String(cString: $0)) }?
    .absoluteString ?? ""
  return resolvedURLLock.withLock {
    free(lastResolvedURL)
    lastResolvedURL = strdup(url)
    return UnsafePointer(lastResolvedURL)
  }
}
