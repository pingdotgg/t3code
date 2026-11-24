import AppIntents
import Foundation

@available(iOS 27.3, macOS 27.3, *)
public enum ThreadRunStatus: String, AppEnum, Sendable {
  case running
  case waiting
  case queued
  case idle
  case error

  public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Thread Status")

  public static let caseDisplayRepresentations: [ThreadRunStatus: DisplayRepresentation] = [
    .running: DisplayRepresentation(
      title: "Running",
      subtitle: "Agent is actively working",
      image: .init(systemName: "play.circle.fill")
    ),
    .waiting: DisplayRepresentation(
      title: "Waiting for Input",
      subtitle: "Needs approval or an answer",
      image: .init(systemName: "hand.raised.circle.fill")
    ),
    .queued: DisplayRepresentation(
      title: "Queued",
      subtitle: "Follow-up queued for next turn",
      image: .init(systemName: "clock.circle.fill")
    ),
    .idle: DisplayRepresentation(
      title: "Idle",
      subtitle: "Ready for instructions",
      image: .init(systemName: "checkmark.circle")
    ),
    .error: DisplayRepresentation(
      title: "Error",
      subtitle: "Last run failed",
      image: .init(systemName: "exclamationmark.triangle.fill")
    ),
  ]

  public init(rawStatus: String) {
    self = ThreadRunStatus(rawValue: rawStatus) ?? .idle
  }
}

@available(iOS 27.3, macOS 27.3, *)
public enum ThreadOrganizationAction: String, AppEnum, Sendable {
  case settle
  case unsettle
  case snooze
  case unsnooze
  case pin
  case unpin
  case archive
  case unarchive

  public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Thread Action")

  public static let caseDisplayRepresentations: [ThreadOrganizationAction: DisplayRepresentation] = [
    .settle: DisplayRepresentation(title: "Settle", image: .init(systemName: "checkmark.circle")),
    .unsettle: DisplayRepresentation(title: "Unsettle", image: .init(systemName: "arrow.uturn.backward.circle")),
    .snooze: DisplayRepresentation(title: "Snooze", image: .init(systemName: "moon.zzz")),
    .unsnooze: DisplayRepresentation(title: "Unsnooze", image: .init(systemName: "sun.max")),
    .pin: DisplayRepresentation(title: "Pin", image: .init(systemName: "pin.fill")),
    .unpin: DisplayRepresentation(title: "Unpin", image: .init(systemName: "pin.slash")),
    .archive: DisplayRepresentation(title: "Archive", image: .init(systemName: "archivebox")),
    .unarchive: DisplayRepresentation(title: "Unarchive", image: .init(systemName: "tray.and.arrow.up")),
  ]
}

@available(iOS 27.3, macOS 27.3, *)
public enum ThreadInteractionMode: String, AppEnum, Sendable {
  case `default`
  case plan

  public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Interaction Mode")

  public static let caseDisplayRepresentations: [ThreadInteractionMode: DisplayRepresentation] = [
    .default: DisplayRepresentation(title: "Default", subtitle: "Agent can edit files and run commands"),
    .plan: DisplayRepresentation(title: "Plan", subtitle: "Agent proposes a plan before changing code"),
  ]
}

@available(iOS 27.3, macOS 27.3, *)
public enum SnoozePreset: String, AppEnum, Sendable {
  case oneHour
  case threeHours
  case tomorrowMorning

  public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Snooze Duration")

  public static let caseDisplayRepresentations: [SnoozePreset: DisplayRepresentation] = [
    .oneHour: DisplayRepresentation(title: "1 Hour"),
    .threeHours: DisplayRepresentation(title: "3 Hours"),
    .tomorrowMorning: DisplayRepresentation(title: "Tomorrow at 9:00 AM"),
  ]

  public func targetDate(from now: Date = Date()) -> Date {
    switch self {
    case .oneHour:
      return now.addingTimeInterval(3_600)
    case .threeHours:
      return now.addingTimeInterval(10_800)
    case .tomorrowMorning:
      let calendar = Calendar.current
      let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now.addingTimeInterval(86_400)
      return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }
  }
}

@available(iOS 27.3, macOS 27.3, *)
public enum ThreadStateFilter: String, AppEnum, Sendable {
  case needsAttention
  case running
  case errored
  case pinned
  case allActive

  public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Thread Filter")

  public static let caseDisplayRepresentations: [ThreadStateFilter: DisplayRepresentation] = [
    .needsAttention: DisplayRepresentation(title: "Needs Attention"),
    .running: DisplayRepresentation(title: "Running"),
    .errored: DisplayRepresentation(title: "Errored"),
    .pinned: DisplayRepresentation(title: "Pinned"),
    .allActive: DisplayRepresentation(title: "All Active"),
  ]
}
