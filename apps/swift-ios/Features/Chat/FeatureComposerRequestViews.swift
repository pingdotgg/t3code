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

                Text(approval.title)
                    .font(T3Typography.navigationTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                    .padding(.top, 5)

                VStack(alignment: .leading, spacing: 5) {
                    Text(detailLabel)
                        .font(T3Typography.supportingStrong)
                        .tracking(0.7)
                        .textCase(.uppercase)
                        .foregroundStyle(T3Colors.textTertiary)

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
                HStack(spacing: 7) {
                    approvalButton(
                        "Approve once",
                        background: T3Colors.accent,
                        action: { onDecision(.allowOnce) }
                    )

                    approvalButton(
                        "Always allow",
                        background: Color.clear,
                        border: T3Colors.border,
                        foreground: T3Colors.textPrimary,
                        action: { onDecision(.allowForSession) }
                    )
                }

                HStack(spacing: 26) {
                    Button("Decline", role: .destructive) {
                        onDecision(.deny)
                    }
                    .foregroundStyle(T3Colors.danger)

                    Button("Cancel turn", action: onCancelTurn)
                        .foregroundStyle(T3Colors.textTertiary)
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
        case .patch: "Patch"
        case .other: "Details"
        }
    }
}

struct FeatureComposerUserInputPanel: View {
    let input: FeatureUserInput
    let isResponding: Bool
    let onSubmit: ([String: FeatureInputAnswer]) -> Void

    @State private var answers: [String: FeatureInputAnswer] = [:]
    @State private var questionIndex = 0

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

                    ScrollView {
                        VStack(spacing: 6) {
                            ForEach(
                                Array(question.options.enumerated()),
                                id: \.element.label
                            ) { index, option in
                                optionButton(option, number: index + 1, question: question)
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.top, 10)
                    }
                    .frame(maxHeight: 320)
                    .scrollIndicators(.hidden)

                    HStack(spacing: 8) {
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

                    HStack(spacing: 8) {
                        if questionIndex > 0 {
                            Button("Back") {
                                questionIndex -= 1
                            }
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
                .disabled(isResponding)
                .opacity(isResponding ? 0.56 : 1)
            }
        }
        .onChange(of: input.id) {
            answers = [:]
            questionIndex = 0
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
        guard let activeQuestion else { return false }
        return normalizedAnswer(for: activeQuestion.id) != nil
    }

    private var normalizedAnswers: [String: FeatureInputAnswer]? {
        var result: [String: FeatureInputAnswer] = [:]
        for question in input.questions {
            guard let answer = normalizedAnswer(for: question.id) else { return nil }
            result[question.id] = answer
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
            onSubmit(normalizedAnswers)
        } else if let unanswered = input.questions.firstIndex(where: {
            normalizedAnswer(for: $0.id) == nil
        }) {
            questionIndex = unanswered
        }
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
