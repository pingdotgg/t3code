import Foundation

public enum T3IntentError: Error, CustomLocalizedStringResourceConvertible, Sendable {
  case environmentNotAuthenticated
  case environmentMismatch
  case environmentUnreachable
  case permissionDenied
  case resourceNotFound
  case invalidInput(String)
  case serverRejected(String)

  public var localizedStringResource: LocalizedStringResource {
    switch self {
    case .environmentNotAuthenticated:
      return "Sign in or pair this T3 Code environment in the app before running actions."
    case .environmentMismatch:
      return "This environment's saved address now answers as a different T3 Code environment. Open T3 Code to reconnect."
    case .environmentUnreachable:
      return "Could not reach this T3 Code environment. Make sure the server or T3 Connect is online."
    case .permissionDenied:
      return "This client session does not have permission to perform that action on the environment."
    case .resourceNotFound:
      return "That project or thread no longer exists in T3 Code."
    case .invalidInput(let detail):
      return "\(detail)"
    case .serverRejected(let detail):
      return "\(detail)"
    }
  }
}
