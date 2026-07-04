import SwiftUI

/// Inline provider-question prompt (`user-input.requested`) rendered as a
/// timeline item. Interactive chrome, so it sits on Liquid Glass like
/// `ApprovalCard`.
public struct UserInputCard: View {
    let request: UserInputRequest
    let onSubmit: ([String: [String]]) -> Void

    @UIState private var selections: [String: Set<String>] = [:]
    @UIState private var freeform: [String: String] = [:]

    public init(request: UserInputRequest, onSubmit: @escaping ([String: [String]]) -> Void) {
        self.request = request
        self.onSubmit = onSubmit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Input needed", systemImage: "questionmark.bubble")
                .font(.callout.weight(.semibold))

            ForEach(request.questions) { question in
                questionSection(question)
            }

            HStack {
                Spacer()
                Button("Submit") {
                    onSubmit(collectAnswers())
                }
                .buttonStyle(.glass)
                .tint(.accentColor)
                .disabled(!isComplete)
            }
        }
        .padding(14)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder
    private func questionSection(_ question: UserInputQuestionItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !question.header.isEmpty {
                Text(question.header)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
            }
            Text(question.question)
                .font(.callout)
                .textSelection(.enabled)

            if question.options.isEmpty {
                TextField(
                    "Your answer",
                    text: Binding(
                        get: { freeform[question.id] ?? "" },
                        set: { freeform[question.id] = $0 }))
                .textFieldStyle(.roundedBorder)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(question.options, id: \.label) { option in
                        optionRow(option, question: question)
                    }
                }
            }
        }
    }

    private func optionRow(_ option: UserInputOption, question: UserInputQuestionItem) -> some View {
        let isSelected = selections[question.id]?.contains(option.label) ?? false
        return Button {
            toggle(option.label, question: question)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(
                    systemName: isSelected
                        ? (question.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                        : (question.multiSelect ? "square" : "circle"))
                .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.callout)
                    if let detail = option.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, 2)
    }

    private func toggle(_ label: String, question: UserInputQuestionItem) {
        var current = selections[question.id] ?? []
        if question.multiSelect {
            if current.contains(label) { current.remove(label) } else { current.insert(label) }
        } else {
            current = current.contains(label) ? [] : [label]
        }
        selections[question.id] = current
    }

    private var isComplete: Bool {
        request.questions.allSatisfy { question in
            if question.options.isEmpty {
                return !(freeform[question.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
            }
            return !(selections[question.id] ?? []).isEmpty
        }
    }

    private func collectAnswers() -> [String: [String]] {
        var answers: [String: [String]] = [:]
        for question in request.questions {
            if question.options.isEmpty {
                let text = (freeform[question.id] ?? "").trimmingCharacters(in: .whitespaces)
                if !text.isEmpty { answers[question.id] = [text] }
            } else if let selected = selections[question.id], !selected.isEmpty {
                // Preserve the option order the provider offered.
                answers[question.id] = question.options.map(\.label).filter(selected.contains)
            }
        }
        return answers
    }
}
