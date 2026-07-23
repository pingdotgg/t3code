import AppKit
import Foundation
import UserNotifications

/// Posts local macOS notifications when agents finish, stall, fail, or need
/// the user. Selection on click is handled by `AgentNotificationService.Delegate`.
@MainActor
public final class AgentNotificationService: NSObject {
    public static let shared = AgentNotificationService()

    public nonisolated static let categoryIdentifier = "agent.lifecycle"
    public nonisolated static let userInfoDeviceIDKey = "deviceID"
    public nonisolated static let userInfoThreadIDKey = "threadID"
    public nonisolated static let userInfoKindKey = "kind"

    /// Invoked on the main actor when the user activates a notification.
    public weak var selectionHandler: AgentNotificationSelectionHandler?

    /// Override for tests; production uses `NSApp.isActive`.
    public var isAppActiveOverride: Bool?

    private var didRequestAuthorization = false
    private var authorizationGranted: Bool?
    /// Collapse approval/input (and status-fallback approval) that land in the
    /// same second so a shell upsert + activity event do not double-banner.
    private var recentAttentionDeliveries: [String: Date] = [:]
    private let attentionDedupeInterval: TimeInterval = 3

    public override init() {
        super.init()
    }

    /// Register the notification category and request authorization once.
    public func prepare() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let category = UNNotificationCategory(
            identifier: Self.categoryIdentifier,
            actions: [],
            intentIdentifiers: [],
            options: [])
        center.setNotificationCategories([category])
        requestAuthorizationIfNeeded()
    }

    public func requestAuthorizationIfNeeded() {
        guard !didRequestAuthorization else { return }
        didRequestAuthorization = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) {
            [weak self] granted, _ in
            Task { @MainActor in
                self?.authorizationGranted = granted
            }
        }
    }

    /// Evaluate a thread status/health transition and notify if warranted.
    public func considerThreadTransition(
        previousStatus: ThreadStatus?,
        previousStalled: Bool,
        thread: ChatThread,
        projectName: String?,
        deviceID: DeviceID,
        selectedThreadID: String?
    ) {
        let previous: AgentNotificationPolicy.ThreadSnapshot? =
            previousStatus.map {
                AgentNotificationPolicy.ThreadSnapshot(status: $0, isStalled: previousStalled)
            }
        let next = AgentNotificationPolicy.ThreadSnapshot(thread)
        guard let kind = AgentNotificationPolicy.statusTransitionKind(previous: previous, next: next)
        else { return }
        deliver(
            kind: kind,
            thread: thread,
            projectName: projectName,
            deviceID: deviceID,
            selectedThreadID: selectedThreadID,
            detail: nil)
    }

    public func considerApproval(
        request: ApprovalRequest,
        thread: ChatThread?,
        projectName: String?,
        deviceID: DeviceID,
        selectedThreadID: String?
    ) {
        let titleThread = thread?.title ?? "Agent"
        deliver(
            kind: .needsApproval,
            threadID: request.threadID,
            threadTitle: titleThread,
            projectName: projectName,
            deviceID: deviceID,
            selectedThreadID: selectedThreadID,
            detail: request.title)
    }

    public func considerUserInput(
        request: UserInputRequest,
        thread: ChatThread?,
        projectName: String?,
        deviceID: DeviceID,
        selectedThreadID: String?
    ) {
        let titleThread = thread?.title ?? "Agent"
        let firstPrompt = request.questions.first?.question
        deliver(
            kind: .needsInput,
            threadID: request.threadID,
            threadTitle: titleThread,
            projectName: projectName,
            deviceID: deviceID,
            selectedThreadID: selectedThreadID,
            detail: firstPrompt)
    }

    private func deliver(
        kind: AgentNotificationKind,
        thread: ChatThread,
        projectName: String?,
        deviceID: DeviceID,
        selectedThreadID: String?,
        detail: String?
    ) {
        deliver(
            kind: kind,
            threadID: thread.id,
            threadTitle: thread.title,
            projectName: projectName,
            deviceID: deviceID,
            selectedThreadID: selectedThreadID,
            detail: detail)
    }

    private func deliver(
        kind: AgentNotificationKind,
        threadID: String,
        threadTitle: String,
        projectName: String?,
        deviceID: DeviceID,
        selectedThreadID: String?,
        detail: String?
    ) {
        let isAppActive = isAppActiveOverride ?? NSApp.isActive
        let context = AgentNotificationPolicy.DeliveryContext(
            isAppActive: isAppActive,
            isThreadSelected: selectedThreadID == threadID)
        guard
            AgentNotificationPolicy.shouldDeliver(
                kind: kind,
                masterEnabled: AgentNotificationPreferences.isMasterEnabled,
                enabledKinds: AgentNotificationPreferences.enabledKinds,
                context: context)
        else { return }

        let attentionKey = "\(deviceID.rawValue).\(threadID)"
        if kind == .needsApproval || kind == .needsInput {
            pruneAttentionDedupe()
            if let last = recentAttentionDeliveries[attentionKey],
                Date().timeIntervalSince(last) < attentionDedupeInterval
            {
                // Prefer the first (usually the more specific event) and drop
                // the status-fallback sibling that arrives moments later.
                return
            }
            recentAttentionDeliveries[attentionKey] = Date()
        }

        let content = UNMutableNotificationContent()
        content.title = AgentNotificationPolicy.notificationTitle(
            kind: kind, threadTitle: threadTitle)
        content.body = AgentNotificationPolicy.notificationBody(
            kind: kind, projectName: projectName, detail: detail)
        content.sound = .default
        content.categoryIdentifier = Self.categoryIdentifier
        content.userInfo = [
            Self.userInfoDeviceIDKey: deviceID.rawValue,
            Self.userInfoThreadIDKey: threadID,
            Self.userInfoKindKey: kind.rawValue,
        ]

        // Collapse concurrent notifications for the same thread+kind so a
        // reconnect snapshot doesn't stack duplicates.
        let identifier = "\(kind.rawValue).\(deviceID.rawValue).\(threadID)"
        let request = UNNotificationRequest(
            identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }

    private func pruneAttentionDedupe() {
        let cutoff = Date().addingTimeInterval(-attentionDedupeInterval * 2)
        recentAttentionDeliveries = recentAttentionDeliveries.filter { $0.value >= cutoff }
    }
}

/// Selection bridge so AppDelegate / MultiDeviceModel can open the thread.
@MainActor
public protocol AgentNotificationSelectionHandler: AnyObject {
    func openThreadFromNotification(deviceID: DeviceID, threadID: String)
}

extension AgentNotificationService: UNUserNotificationCenterDelegate {
    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // When the app is frontmost but the user is on another thread, still
        // show a banner (delivery already suppressed for the selected thread).
        completionHandler([.banner, .sound, .list])
    }

    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let deviceRaw = userInfo[AgentNotificationService.userInfoDeviceIDKey] as? String
        let threadID = userInfo[AgentNotificationService.userInfoThreadIDKey] as? String
        // Complete the system callback immediately; hop to MainActor only for
        // selection so we do not capture the completion handler across isolation.
        if let deviceRaw, let threadID {
            Task { @MainActor in
                AgentNotificationService.shared.selectionHandler?
                    .openThreadFromNotification(
                        deviceID: DeviceID(rawValue: deviceRaw), threadID: threadID)
            }
        }
        completionHandler()
    }
}
