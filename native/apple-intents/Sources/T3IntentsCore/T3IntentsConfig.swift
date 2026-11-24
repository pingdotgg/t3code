import Foundation
#if os(macOS)
import Security
#endif

public enum T3IntentsConfig {
  /// Fallback for unsigned dev builds; signed builds read the team from their own entitlements.
  public static let teamId = "ARK85ZXQ4Z"
  public static let iosBundleIdentifierDefault = "com.t3tools.t3code"
  public static let macBundleIdentifierDefault = "com.t3tools.t3code"
  public static let orchestrationProtocolHeader = "x-t3-orchestration-protocol"
  public static let orchestrationProtocolVersion = "2"
  public static let urlScheme = "t3code"
  public static let keychainService = "com.t3tools.t3code.apple-intents.credentials"
  public static let dpopKeychainService = "com.t3tools.t3code.dpop"
  public static let spotlightDomainPrefix = "com.t3tools.t3code"
  public static let threadActivityType = "com.t3tools.t3code.view-thread"
  public static let projectActivityType = "com.t3tools.t3code.view-project"

  public static var appGroupIdentifier: String {
    if let configured = Bundle.main.object(forInfoDictionaryKey: "T3AppGroupIdentifier") as? String,
       !configured.isEmpty {
      return configured
    }
    #if os(macOS)
    // The host app and extension are signed with the same group, so it never drifts from the team.
    if let entitled = signedEntitlementStrings("com.apple.security.application-groups").first {
      return entitled
    }
    return "\(teamId).\(macBundleIdentifierDefault)"
    #else
    let bundleId = Bundle.main.bundleIdentifier ?? iosBundleIdentifierDefault
    // Strip known extension suffixes so extensions resolve the parent app group.
    let baseBundleId = bundleId
      .replacingOccurrences(of: ".appintents", with: "")
      .replacingOccurrences(of: ".share-extension", with: "")
      .replacingOccurrences(of: ".ExpoWidgetsTarget", with: "")
    return "group.\(baseBundleId)"
    #endif
  }

  public static var keychainAccessGroup: String? {
    if let configured = Bundle.main.object(forInfoDictionaryKey: "T3KeychainAccessGroup") as? String,
       !configured.isEmpty {
      return configured
    }
    #if os(macOS)
    // `TEAM.com.t3tools.t3code`: the host's application identifier and the extension's keychain group.
    return appGroupIdentifier
    #else
    return nil
    #endif
  }

  #if os(macOS)
  private static func signedEntitlementStrings(_ key: String) -> [String] {
    guard let task = SecTaskCreateFromSelf(nil),
          let value = SecTaskCopyValueForEntitlement(task, key as CFString, nil)
    else {
      return []
    }
    return (value as? [String]) ?? []
  }
  #endif

  public static var sharedContainerDirectory: URL {
    if let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) {
      return container
    }
    // Fallback for unsigned dev builds or swift test environments without App Group provisioning.
    let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    return appSupport.appendingPathComponent("T3CodeAppleIntents", isDirectory: true)
  }

  public static var indexDatabaseURL: URL {
    sharedContainerDirectory.appendingPathComponent("apple-intents-index.sqlite", isDirectory: false)
  }
}
