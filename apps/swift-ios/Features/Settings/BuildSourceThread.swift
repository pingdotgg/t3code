import Foundation

/// Build-time metadata naming the T3 thread whose work produced this build.
///
/// The values are embedded by the build itself: the `T3CODE_SOURCE_THREAD_*` build
/// settings expand into Info.plist. Nothing is fetched at runtime, so a personal Dev
/// or Test build can always say where it came from. Builds that record nothing are
/// the normal case, so every accessor treats absent values as "not recorded".
public struct BuildSourceThread: Equatable, Sendable {
    public static let threadIDInfoKey = "T3SourceThreadID"
    public static let environmentIDInfoKey = "T3SourceThreadEnvironmentID"
    public static let titleInfoKey = "T3SourceThreadTitle"

    /// The identifier recorded at build time. May be a thread's local id or its wire id.
    public let threadID: String
    public let environmentID: String?
    /// The title as it read when the build was made, used only when the thread is not local.
    public let recordedTitle: String?

    public init(threadID: String, environmentID: String? = nil, recordedTitle: String? = nil) {
        self.threadID = threadID
        self.environmentID = environmentID
        self.recordedTitle = recordedTitle
    }

    public static func recorded(in infoDictionary: [String: Any]?) -> BuildSourceThread? {
        guard let threadID = embeddedValue(infoDictionary?[threadIDInfoKey]) else { return nil }
        return BuildSourceThread(
            threadID: threadID,
            environmentID: embeddedValue(infoDictionary?[environmentIDInfoKey]),
            recordedTitle: embeddedValue(infoDictionary?[titleInfoKey])
        )
    }

    public static func recorded(in bundle: Bundle = .main) -> BuildSourceThread? {
        recorded(in: bundle.infoDictionary)
    }

    /// An unset build setting expands to an empty string, and a misconfigured build can
    /// leave the literal `$(NAME)` placeholder behind. Neither is a usable identity.
    private static func embeddedValue(_ rawValue: Any?) -> String? {
        guard let value = (rawValue as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty,
              !value.hasPrefix("$(")
        else { return nil }
        return value
    }
}

/// What the Settings row can offer for this build's source thread.
public enum BuildSourceThreadPresentation: Equatable, Sendable {
    /// The build embedded no thread identity.
    case notRecorded
    /// A thread was recorded but this device cannot resolve it to exactly one local thread.
    case unresolved(title: String)
    /// The recorded thread exists here and can be opened by its existing identity.
    case openable(threadID: String, title: String)

    public var isInteractive: Bool {
        if case .openable = self { return true }
        return false
    }

    public var title: String {
        switch self {
        case .notRecorded: "Not recorded"
        case let .unresolved(title): title
        case let .openable(_, title): title
        }
    }

    /// Secondary text explaining a noninteractive state; nil when the row can be opened.
    public var detail: String? {
        switch self {
        case .notRecorded: "This build did not record a source thread."
        case .unresolved: "Not available on this device."
        case .openable: nil
        }
    }
}

public enum BuildSourceThreadResolver {
    public static func presentation(
        for recorded: BuildSourceThread?,
        in snapshot: FeatureSnapshot
    ) -> BuildSourceThreadPresentation {
        guard let recorded else { return .notRecorded }
        guard let thread = resolve(recorded, in: snapshot) else {
            return .unresolved(title: fallbackTitle(for: recorded))
        }
        let title = thread.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return .openable(
            threadID: thread.id,
            title: title.isEmpty ? fallbackTitle(for: recorded) : title
        )
    }

    /// Mirrors `PlatformRouteResolver.thread` so a build link lands on exactly the thread a
    /// deep link would. The Features layer cannot reference the Platform layer, so the rule
    /// is restated here rather than imported.
    static func resolve(
        _ recorded: BuildSourceThread,
        in snapshot: FeatureSnapshot
    ) -> FeatureThread? {
        let matches = snapshot.threads.filter { thread in
            (recorded.environmentID == nil || thread.environmentID == recorded.environmentID)
                && (thread.id == recorded.threadID || thread.wireID == recorded.threadID)
        }
        // Without a recorded environment an ambiguous match could open an unrelated thread.
        guard recorded.environmentID != nil || matches.count == 1 else { return nil }
        return matches.max { $0.updatedAt < $1.updatedAt }
    }

    static func fallbackTitle(for recorded: BuildSourceThread) -> String {
        if let recordedTitle = recorded.recordedTitle?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !recordedTitle.isEmpty {
            return recordedTitle
        }
        return "Thread \(recorded.threadID.prefix(8))"
    }
}
