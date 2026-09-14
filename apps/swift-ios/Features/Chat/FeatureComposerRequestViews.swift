import SwiftUI

struct FeatureComposerApprovalPanel: View {
    let approval: FeatureApproval
    let position: Int
    let total: Int
    let isResponding: Bool
    let onDecision: (FeatureApprovalDecision) -> Void
    let onCancelTurn: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text("Pending approval")
                        .font(T3Typography.eyebrow)
                        .tracking(1.3)
                        .textCase(.uppercase)
                        .foregroundStyle(T3Colors.warning)

                    Spacer()

                    if total > 1 {
                        Text("\(position)/\(total)")
                            .font(T3Typography.supportingStrong.monospacedDigit())
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                }

                Text(approval.appName ?? approval.title)
                    .font(T3Typography.navigationTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                    .padding(.top, 5)

                VStack(alignment: .leading, spacing: 5) {
                    Text(detailLabel)
                        .font(T3Typography.supportingStrong)
                        .tracking(0.7)
                        .textCase(.uppercase)
                        .foregroundStyle(T3Colors.textTertiary)

                    // A patch or command can be a whole diff. Scroll it so
                    // the decision buttons below never leave the screen.
                    ScrollView {
                        Text(approval.detail)
                            .font(
                                approval.kind == .command
                                    ? T3Typography.code
                                    : T3Typography.threadBody
                            )
                            .foregroundStyle(T3Colors.textPrimary.opacity(0.92))
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .t3CodeTextSize(approval.kind == .command)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 220)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 10))
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(T3Colors.border, lineWidth: 1)
                }
                .padding(.top, 9)
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 12)
            .background(T3Colors.subtle)

            Divider().overlay(T3Colors.separator)

            VStack(spacing: 9) {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 7) {
                    ForEach(positiveOptions) { option in
                        approvalButton(
                            option.label,
                            background: option.decision == .allowOnce ? T3Colors.accent : .clear,
                            border: option.decision == .allowOnce ? .clear : T3Colors.border,
                            foreground: option.decision == .allowOnce ? .white : T3Colors.textPrimary,
                            action: { onDecision(option.decision) }
                        )
                    }
                }

                HStack(spacing: 26) {
                    ForEach(negativeOptions) { option in
                        Button(option.label, role: .destructive) {
                            onDecision(option.decision)
                        }
                        .foregroundStyle(T3Colors.danger)
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                    }

                    Button("Cancel turn", action: onCancelTurn)
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                }
                .font(T3Typography.supportingStrong)
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 10)
            .padding(.top, 10)
            .padding(.bottom, 11)
        }
        .disabled(isResponding)
        .opacity(isResponding ? 0.56 : 1)
        .accessibilityElement(children: .contain)
    }

    private func approvalButton(
        _ title: String,
        background: Color,
        border: Color = .clear,
        foreground: Color = .white,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(T3Typography.control.weight(.semibold))
                .foregroundStyle(foreground)
                .frame(maxWidth: .infinity)
                .frame(height: T3Metrics.minimumTapTarget)
                .background(background, in: RoundedRectangle(cornerRadius: 10))
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(border, lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
    }

    private var detailLabel: String {
        switch approval.kind {
        case .command: "Command"
        case .fileRead: "File access"
        case .fileChange: "File change"
        case .mcpElicitation: "App access"
        case .patch: "Patch"
        case .other: "Details"
        }
    }

    private var options: [FeatureApprovalOption] {
        approval.options ?? [
            FeatureApprovalOption(decision: .allowOnce, label: "Approve once"),
            FeatureApprovalOption(decision: .allowForSession, label: "Allow session"),
            FeatureApprovalOption(decision: .deny, label: "Decline"),
        ]
    }

    private var positiveOptions: [FeatureApprovalOption] {
        options.filter { $0.decision != .deny && $0.decision != .cancel }
    }

    private var negativeOptions: [FeatureApprovalOption] {
        options.filter { $0.decision == .deny || $0.decision == .cancel }
    }
}

struct FeatureComposerUserInputPanel: View {
    let input: FeatureUserInput
    let isResponding: Bool
    let onSubmit: ([String: FeatureInputAnswer], [String: [FeatureUploadAttachment]]) async -> Void
    var onDismiss: (() async -> Void)? = nil
    var environmentID: String? = nil
    var attachmentPreferences = FeatureEnvironmentPreferences()

    @State private var answers: [String: FeatureInputAnswer] = [:]
    @State private var questionIndex = 0
    @State private var attachmentsByQuestionID: [String: [FeatureDraftAttachment]] = [:]
    @State private var preparation = FeatureAttachmentPreparationState()
    @State private var attachmentFlowActive = false
    @State private var restoredInputID: String?
    @State private var draftError: String?
    @State private var draftWrite: Task<Void, Never>?
    @State private var isSubmittingAnswer = false

    var body: some View {
        Group {
            if let question = activeQuestion {
                VStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 8) {
                            Text(question.header)
                                .font(T3Typography.eyebrow)
                                .tracking(1.3)
                                .textCase(.uppercase)
                                .foregroundStyle(T3Colors.accent)

                            Spacer()

                            if input.questions.count > 1 {
                                Text("\(questionIndex + 1)/\(input.questions.count)")
                                    .font(T3Typography.supportingStrong.monospacedDigit())
                                    .foregroundStyle(T3Colors.textTertiary)
                            }
                        }

                        Text(question.question)
                            .font(T3Typography.navigationTitle)
                            .foregroundStyle(T3Colors.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 5)

                        if question.allowsMultiple {
                            Text("Select one or more options")
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textTertiary)
                                .padding(.top, 4)
                        }
                    }
                    .padding(.horizontal, 15)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(T3Colors.subtle)

                    Divider().overlay(T3Colors.separator)

                    if !question.options.isEmpty {
                        ScrollView {
                            VStack(spacing: 6) {
                                ForEach(
                                    Array(question.options.enumerated()),
                                    id: \.element.label
                                ) { index, option in
                                    optionButton(option, number: index + 1, question: question)
                                        .disabled(preparation.isPreparing || attachmentFlowActive)
                                }
                            }
                            .padding(.horizontal, 10)
                            .padding(.top, 10)
                        }
                        .frame(maxHeight: 320)
                        .scrollIndicators(.hidden)
                    }

                    if question.canWriteCustomAnswer {
                        HStack(spacing: 8) {
                            if input.supportsAttachments == true {
                                FeatureImageAttachmentPicker(
                                    attachments: attachmentBinding(questionID: question.id),
                                    preparationState: $preparation,
                                    isFlowActive: $attachmentFlowActive,
                                    draftOwnerID: "\(input.id):\(question.id)",
                                    environmentID: environmentID,
                                    imagesAllowed: attachmentPreferences.supportsImageUploads,
                                    maximumFileBytes: attachmentPreferences.maxFileAttachmentBytes,
                                    maximumCount: max(0, FeatureImageAttachmentLimits.maximumCount - otherAttachmentCount(questionID: question.id))
                                )
                                .disabled(restoredInputID != input.id)
                            }
                            Image(systemName: "pencil")
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textTertiary)

                            TextField(
                                "Write custom answer",
                                text: answerBinding(for: question),
                                axis: .vertical
                            )
                            .font(T3Typography.composer)
                            .lineLimit(1...4)
                            .submitLabel(.return)
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                        .background(
                            T3Colors.input,
                            in: RoundedRectangle(cornerRadius: 11)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 11)
                                .stroke(T3Colors.inputBorder, lineWidth: 1)
                        }
                        .padding(.horizontal, 10)
                        .padding(.top, 7)
                    }

                    if !(attachmentsByQuestionID[question.id] ?? []).isEmpty {
                        FeatureAttachmentStrip(attachments: attachmentBinding(questionID: question.id))
                            .padding(.horizontal, 10)
                    }
                    if preparation.isPreparing || isResponding || isSubmittingAnswer {
                        Text(preparation.isPreparing ? preparation.statusLabel : responseStatus)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .padding(.top, 6)
                    }
                    if let draftError {
                        Text(draftError)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.danger)
                            .padding(.horizontal, 10)
                    }
                    if let attachmentBlocker {
                        Text(attachmentBlocker)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.danger)
                            .padding(.horizontal, 10)
                    }

                    HStack(spacing: 8) {
                        if input.canDismiss, let onDismiss {
                            Button("Dismiss") {
                                let pendingWrite = draftWrite
                                isSubmittingAnswer = true
                                Task { @MainActor in
                                    defer { isSubmittingAnswer = false }
                                    await pendingWrite?.value
                                    await onDismiss()
                                }
                            }
                                .font(T3Typography.control)
                                .foregroundStyle(T3Colors.textSecondary)
                                .frame(minHeight: T3Metrics.minimumTapTarget)
                                .accessibilityLabel("Dismiss question without replying")
                                .disabled(preparation.isPreparing || attachmentFlowActive)
                        }
                        if questionIndex > 0 {
                            Button("Back") {
                                questionIndex -= 1
                            }
                            .disabled(preparation.isPreparing || attachmentFlowActive)
                            .font(T3Typography.control.weight(.semibold))
                            .foregroundStyle(T3Colors.textSecondary)
                            .frame(
                                minWidth: T3Metrics.minimumTapTarget,
                                minHeight: T3Metrics.minimumTapTarget
                            )
                        }

                        Spacer()

                        Button(action: advanceOrSubmit) {
                            Text(isLastQuestion ? "Submit" : "Next question")
                                .font(T3Typography.control.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 18)
                                .frame(height: T3Metrics.minimumTapTarget)
                                .background(T3Colors.accent, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(!canAdvance)
                        .opacity(canAdvance ? 1 : 0.3)
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 9)
                    .padding(.bottom, 11)
                }
                .disabled(isResponding || isSubmittingAnswer)
                .opacity(isResponding || isSubmittingAnswer ? 0.56 : 1)
            }
        }
        .onChange(of: input.id) {
            answers = [:]
            questionIndex = 0
            restoredInputID = nil
            attachmentsByQuestionID = [:]
            draftError = nil
        }
        .task(id: input.id) {
            let requestID = input.id
            do {
                let stored = try await FeatureComposerDraftStore.shared.draft(
                    for: FeatureQuestionAttachmentDraft.key(inputID: requestID)
                )
                try Task.checkCancellation()
                guard requestID == input.id else { return }
                attachmentsByQuestionID = try FeatureQuestionAttachmentDraft.decode(stored)
                    .filter { questionIDs.contains($0.key) }
                restoredInputID = requestID
            } catch is CancellationError {
                return
            } catch {
                restoredInputID = requestID
                draftError = "Could not restore question attachments."
            }
        }
        .onChange(of: attachmentsByQuestionID) { _, current in
            guard restoredInputID == input.id else { return }
            let key = FeatureQuestionAttachmentDraft.key(inputID: input.id)
            let previousWrite = draftWrite
            draftWrite = Task {
                await previousWrite?.value
                do {
                    try await FeatureComposerDraftStore.shared.setDraft(
                        FeatureQuestionAttachmentDraft.encode(current), for: key
                    )
                    draftError = nil
                } catch {
                    draftError = "Could not save question attachments. Keep this thread open to send them."
                }
            }
        }
        .onChange(of: questionIDs) { previousIDs, currentIDs in
            questionIndex = FeatureComposerQuestionReconciliation.index(
                current: questionIndex,
                previousQuestionIDs: previousIDs,
                currentQuestionIDs: currentIDs
            )
            answers = FeatureComposerQuestionReconciliation.answers(
                answers,
                currentQuestionIDs: currentIDs
            )
            attachmentsByQuestionID = attachmentsByQuestionID.filter { currentIDs.contains($0.key) }
        }
    }

    private var activeQuestion: FeatureInputQuestion? {
        guard input.questions.indices.contains(questionIndex) else { return nil }
        return input.questions[questionIndex]
    }

    private var questionIDs: [String] {
        input.questions.map(\.id)
    }

    private var isLastQuestion: Bool {
        questionIndex >= input.questions.count - 1
    }

    private var canAdvance: Bool {
        guard let activeQuestion, !isSubmittingAnswer, !preparation.isPreparing, !attachmentFlowActive,
              restoredInputID == input.id, attachmentBlocker == nil else { return false }
        return normalizedAnswer(for: activeQuestion.id) != nil || hasAttachments(for: activeQuestion.id)
    }

    private var normalizedAnswers: [String: FeatureInputAnswer]? {
        var result: [String: FeatureInputAnswer] = [:]
        for question in input.questions {
            if let answer = normalizedAnswer(for: question.id) {
                result[question.id] = answer
            } else if !hasAttachments(for: question.id) {
                return nil
            }
        }
        return result
    }

    private func optionButton(
        _ option: FeatureInputOption,
        number: Int,
        question: FeatureInputQuestion
    ) -> some View {
        let isSelected = isOptionSelected(option.label, for: question)

        return Button {
            select(option.label, for: question)
        } label: {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textPrimary)

                    if !option.detail.isEmpty, option.detail != option.label {
                        Text(option.detail)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 8)

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(T3Typography.supporting.weight(.bold))
                        .foregroundStyle(T3Colors.accent)
                } else if number <= 9 {
                    Text("\(number)")
                        .font(.caption2.monospacedDigit().weight(.semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 20, height: 20)
                        .overlay {
                            RoundedRectangle(cornerRadius: 5)
                                .stroke(T3Colors.border, lineWidth: 1)
                        }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
            .background(
                isSelected ? T3Colors.accent.opacity(0.12) : T3Colors.subtle,
                in: RoundedRectangle(cornerRadius: 10)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(
                        isSelected ? T3Colors.accent.opacity(0.46) : Color.clear,
                        lineWidth: 1
                    )
            }
        }
        .buttonStyle(.plain)
    }

    private func answerBinding(for question: FeatureInputQuestion) -> Binding<String> {
        Binding(
            get: {
                FeatureComposerCustomAnswer.text(
                    in: answers[question.id],
                    for: question
                )
            },
            set: {
                answers[question.id] = FeatureComposerCustomAnswer.replacingText(
                    in: answers[question.id],
                    with: $0,
                    for: question
                )
            }
        )
    }

    private func select(_ label: String, for question: FeatureInputQuestion) {
        answers[question.id] = (answers[question.id] ?? .selections([]))
            .togglingOption(label, allowsMultiple: question.allowsMultiple)
        if question.allowsMultiple {
            return
        }
        guard !isLastQuestion else { return }
        let selectedQuestionID = question.id
        Task { @MainActor in
            await Task.yield()
            guard activeQuestion?.id == selectedQuestionID,
                  !isLastQuestion else {
                return
            }
            questionIndex += 1
        }
    }

    private func advanceOrSubmit() {
        guard canAdvance else { return }
        if !isLastQuestion {
            questionIndex += 1
        } else if let normalizedAnswers {
            let submitted = attachmentsByQuestionID.filter { hasAttachments(for: $0.key) }
                .mapValues { $0.map(FeatureUploadAttachment.init) }
            let pendingWrite = draftWrite
            isSubmittingAnswer = true
            Task { @MainActor in
                defer { isSubmittingAnswer = false }
                await pendingWrite?.value
                await onSubmit(normalizedAnswers, submitted)
            }
        } else if let unanswered = input.questions.firstIndex(where: {
            normalizedAnswer(for: $0.id) == nil && !hasAttachments(for: $0.id)
        }) {
            questionIndex = unanswered
        }
    }

    private func hasAttachments(for questionID: String) -> Bool {
        input.supportsAttachments == true
            && input.questions.contains { $0.id == questionID && $0.canWriteCustomAnswer }
            && !(attachmentsByQuestionID[questionID] ?? []).isEmpty
    }

    private var responseStatus: String {
        attachmentsByQuestionID.values.contains { !$0.isEmpty }
            ? "Uploading attachments and sending answer..."
            : "Sending answer..."
    }

    private var attachmentBlocker: String? {
        if attachmentsByQuestionID.contains(where: { !$0.value.isEmpty && !hasAttachments(for: $0.key) }) {
            return "Attachments are no longer supported for this question. Remove them to send the answer."
        }
        return nil
    }

    private func otherAttachmentCount(questionID: String) -> Int {
        attachmentsByQuestionID.reduce(0) { count, entry in
            count + (entry.key == questionID ? 0 : entry.value.count)
        }
    }

    private func attachmentBinding(questionID: String) -> Binding<[FeatureDraftAttachment]> {
        let requestID = input.id
        return Binding(
            get: { attachmentsByQuestionID[questionID] ?? [] },
            set: { next in
                guard requestID == input.id else { return }
                attachmentsByQuestionID[questionID] = next
            }
        )
    }

    private func normalizedAnswer(for questionID: String) -> FeatureInputAnswer? {
        answers[questionID]?.normalized
    }

    private func isOptionSelected(_ label: String, for question: FeatureInputQuestion) -> Bool {
        switch answers[question.id] {
        case let .text(value):
            return !question.allowsMultiple && value == label
        case let .selections(values):
            return values.contains(label)
        case nil:
            return false
        }
    }
}

enum FeatureComposerCustomAnswer {
    static func text(
        in answer: FeatureInputAnswer?,
        for question: FeatureInputQuestion
    ) -> String {
        let optionLabels = Set(question.options.map(\.label))
        switch answer {
        case let .text(value):
            return optionLabels.contains(value) ? "" : value
        case let .selections(values):
            return values.first(where: { !optionLabels.contains($0) }) ?? ""
        case nil:
            return ""
        }
    }

    static func replacingText(
        in answer: FeatureInputAnswer?,
        with text: String,
        for question: FeatureInputQuestion
    ) -> FeatureInputAnswer {
        guard question.allowsMultiple else { return .text(text) }
        let optionLabels = Set(question.options.map(\.label))
        let selectedOptions: [String]
        if case let .selections(values) = answer {
            selectedOptions = values.filter(optionLabels.contains)
        } else {
            selectedOptions = []
        }
        return .selections(text.isEmpty ? selectedOptions : selectedOptions + [text])
    }
}

enum FeatureComposerQuestionReconciliation {
    static func index(
        current: Int,
        previousQuestionIDs: [String],
        currentQuestionIDs: [String]
    ) -> Int {
        guard !currentQuestionIDs.isEmpty else { return 0 }
        if previousQuestionIDs.indices.contains(current),
           let retained = currentQuestionIDs.firstIndex(
               of: previousQuestionIDs[current]
           ) {
            return retained
        }
        return min(max(0, current), currentQuestionIDs.count - 1)
    }

    static func answers(
        _ answers: [String: FeatureInputAnswer],
        currentQuestionIDs: [String]
    ) -> [String: FeatureInputAnswer] {
        let liveIDs = Set(currentQuestionIDs)
        return answers.filter { liveIDs.contains($0.key) }
    }
}
