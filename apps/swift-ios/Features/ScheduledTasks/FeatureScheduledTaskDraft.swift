import Foundation

struct FeatureScheduledTaskDraft: Equatable {
    enum ScheduleMode: String, CaseIterable { case fixedTime, interval, webhook }
    enum Workspace: String, CaseIterable { case worktree, root, existingWorktree }

    let environmentID: String
    let original: ScheduledTask?
    // Retry an uncertain create with the same identity instead of making a second task.
    let commandID: String
    var title = ""
    var prompt = ""
    var enabled = true
    var projectID: String
    var selection: FeatureSelection?
    var scheduleMode = ScheduleMode.fixedTime
    var timeOfDay = "09:00"
    var weekdays: Set<Int> = [1, 2, 3, 4, 5]
    var intervalMinutes = "15"
    var maxDeliveryAgeMinutes = ""
    var workspace = Workspace.worktree
    var baseRef = "main"
    var checkoutPath = ""
    var branch = ""
    var startFromOrigin: Bool? = true
    var runtimeMode = RuntimeMode.fullAccess
    var interactionMode = InteractionMode.default

    init(environmentID: String, task: ScheduledTask? = nil,
         project: FeatureProject? = nil, selection: FeatureSelection? = nil,
         commandID: String = UUID().uuidString) {
        self.environmentID = environmentID
        original = task
        self.commandID = commandID
        projectID = project?.id ?? task.map {
            FeatureScopedID.project(environmentID: environmentID, wireID: $0.projectId)
        } ?? ""
        self.selection = selection
        guard let task else { return }
        title = task.title
        prompt = task.prompt
        enabled = task.enabled
        self.selection = Self.featureSelection(task.modelSelection)
        runtimeMode = task.runtimeMode
        interactionMode = task.interactionMode
        switch task.schedule {
        case let .webhook(_, maxAge):
            scheduleMode = .webhook
            maxDeliveryAgeMinutes = maxAge.map(String.init) ?? ""
        case let .interval(everyMs):
            scheduleMode = .interval
            intervalMinutes = String(Double(everyMs) / 60_000)
        case let .fixedTime(time, days):
            timeOfDay = time
            weekdays = Set(days.flatMap { $0.isEmpty ? nil : $0 } ?? Array(0...6))
        }
        switch task.workspaceStrategy {
        case let .root(branch):
            workspace = .root
            self.branch = branch ?? ""
        case let .existingWorktree(path, branch):
            workspace = .existingWorktree
            checkoutPath = path
            self.branch = branch ?? ""
        case let .worktree(baseRef, branch, startFromOrigin):
            self.baseRef = baseRef
            self.branch = branch ?? ""
            self.startFromOrigin = startFromOrigin
        }
    }

    func input(projects: [FeatureProject], latestTask: ScheduledTask? = nil) throws -> ScheduledTaskUpsertInput {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw invalid("Add a task name.")
        }
        let prompt = self.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty || scheduleMode == .webhook else {
            throw invalid("Add a prompt.")
        }
        guard let project = projects.first(where: { $0.id == projectID && $0.environmentID == environmentID }) else {
            throw invalid("Choose a project in this environment.")
        }
        let wireProjectID: String
        if let id = project.wireID {
            wireProjectID = id
        } else {
            // Legacy snapshots used raw IDs. A newer scoped ID without its wire ID needs a refresh.
            guard !project.id.hasPrefix("project:\(environmentID.utf8.count):\(environmentID)") else {
                throw invalid("Refresh the project list before saving this task.")
            }
            wireProjectID = project.id
        }
        if let original, original.threadId != nil, original.projectId != wireProjectID {
            throw invalid("This task runs in an existing thread. Keep its original project.")
        }
        guard let selection, !selection.providerID.isEmpty, !selection.modelID.isEmpty else {
            throw invalid("Choose a model.")
        }
        let model: ModelSelection
        if let original, selection == Self.featureSelection(original.modelSelection) {
            // Keep unrecognized options and omitted defaults when editing unrelated fields.
            model = original.modelSelection
        } else {
            model = ModelSelection(instanceId: selection.providerID, model: selection.modelID,
                options: selection.options.map { option in
                    let value: JSONValue = switch option.value {
                    case let .string(value): .string(value)
                    case let .boolean(value): .bool(value)
                    }
                    return ModelSelection.OptionSelection(id: option.id, value: value)
                })
        }
        return ScheduledTaskUpsertInput(
            id: original?.id, requireExisting: original == nil ? nil : true, commandId: commandID,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            prompt: prompt.isEmpty ? "Handle this webhook:\n{{body}}" : prompt, enabled: enabled,
            schedule: try schedule(latestTask: latestTask), projectId: wireProjectID, threadId: original?.threadId,
            workspaceStrategy: try workspaceStrategy(), modelSelection: model,
            runtimeMode: runtimeMode, interactionMode: interactionMode,
            createdBy: original?.createdBy ?? .user, creationSource: original?.creationSource ?? .mobile
        )
    }

    func schedule(latestTask: ScheduledTask? = nil) throws -> ScheduledTaskSchedule {
        switch scheduleMode {
        case .webhook:
            let age = maxDeliveryAgeMinutes.trimmingCharacters(in: .whitespacesAndNewlines)
            let minutes: Int?
            if age.isEmpty { minutes = nil }
            else {
                guard age.allSatisfy({ $0.isASCII && $0.isNumber }),
                      let value = Int(age), (1...1440).contains(value) else {
                    throw invalid("Enter a whole number from 1 to 1440 minutes, or leave it empty.")
                }
                minutes = value
            }
            let signature: ScheduledTaskWebhookSignature?
            if let original {
                guard let latestTask, latestTask.id == original.id else {
                    throw invalid("Refresh this task before saving its webhook settings.")
                }
                if case let .webhook(current, _) = latestTask.schedule { signature = current }
                else { signature = nil }
            } else { signature = nil }
            return .webhook(signature: signature, maxDeliveryAgeMinutes: minutes)
        case .interval:
            guard let minutes = Double(intervalMinutes), minutes.isFinite, minutes >= 1 else {
                throw invalid("Set an interval of at least one minute.")
            }
            let milliseconds = (minutes * 60_000).rounded()
            guard milliseconds <= 9_007_199_254_740_991 else {
                throw invalid("Use a shorter interval.")
            }
            return .interval(everyMs: Int(milliseconds))
        case .fixedTime:
            let time = timeOfDay.trimmingCharacters(in: .whitespacesAndNewlines)
            guard time.range(of: #"^([01]?[0-9]|2[0-3]):[0-5][0-9]$"#, options: .regularExpression) != nil else {
                throw invalid("Enter a time from 00:00 to 23:59.")
            }
            guard !weekdays.isEmpty, weekdays.allSatisfy({ (0...6).contains($0) }) else {
                throw invalid("Choose at least one weekday.")
            }
            return .fixedTime(timeOfDay: time, weekdays: weekdays.count == 7 ? nil : weekdays.sorted())
        }
    }

    func workspaceStrategy() throws -> ScheduledTaskWorkspaceStrategy {
        let branch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        let selectedBranch = branch.isEmpty ? nil : branch
        switch workspace {
        case .root: return .root(branch: selectedBranch)
        case .existingWorktree:
            let path = checkoutPath.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !path.isEmpty else { throw invalid("Enter the existing worktree path on this environment.") }
            return .existingWorktree(worktreePath: path, branch: selectedBranch)
        case .worktree:
            let baseRef = baseRef.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !baseRef.isEmpty else { throw invalid("Enter the base branch for new worktrees.") }
            return .worktree(baseRef: baseRef, branch: selectedBranch, startFromOrigin: startFromOrigin)
        }
    }

    static func featureSelection(_ selection: ModelSelection) -> FeatureSelection {
        FeatureSelection(providerID: selection.instanceId, modelID: selection.model,
            options: (selection.options ?? []).compactMap { option in
                switch option.value {
                case let .string(value): .init(id: option.id, value: .string(value))
                case let .bool(value): .init(id: option.id, value: .boolean(value))
                default: nil
                }
            })
    }

    private func invalid(_ message: String) -> FeatureScheduledTaskError { .invalidDraft(message) }
}

extension ScheduledTaskSchedule {
    var summary: String {
        switch self {
        case .webhook: return "On webhook"
        case let .interval(everyMs):
            let units: [(Int, String)] = [(604_800_000, "week"), (86_400_000, "day"), (3_600_000, "hour"),
                                        (60_000, "minute"), (1_000, "second"), (1, "millisecond")]
            var remaining = everyMs
            var parts: [String] = []
            for (size, label) in units {
                let count = remaining / size
                if count > 0 { parts.append("\(count) \(label)\(count == 1 ? "" : "s")") }
                remaining %= size
            }
            return "Every \(parts.joined(separator: " "))"
        case let .fixedTime(time, days):
            let weekdays = Set(days ?? [])
            if weekdays.isEmpty || weekdays.count == 7 { return "Daily at \(time)" }
            if weekdays == Set([1, 2, 3, 4, 5]) { return "Weekdays at \(time)" }
            let labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            let names = weekdays.sorted().compactMap { labels.indices.contains($0) ? labels[$0] : nil }
            return "\(names.joined(separator: ", ")) at \(time)"
        }
    }
}
