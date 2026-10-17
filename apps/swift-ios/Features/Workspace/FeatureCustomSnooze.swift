import Foundation
import SwiftUI

enum FeatureCustomSnoozeInput: Equatable {
    enum Unit: String, CaseIterable, Identifiable {
        case minutes, hours, days

        var id: Self { self }
        var seconds: TimeInterval {
            switch self {
            case .minutes: 60
            case .hours: 3_600
            case .days: 86_400
            }
        }
    }

    case date(Date)
    case duration(amount: String, unit: Unit)

    /// Durations start at confirmation, and a day is 24 elapsed hours across DST.
    func resolve(now: Date) -> Date? {
        let until: Date
        switch self {
        case let .date(date):
            until = date
        case let .duration(amount, unit):
            guard let value = Double(amount.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: ",", with: ".")), value.isFinite, value > 0 else { return nil }
            until = now.addingTimeInterval(value * unit.seconds)
        }
        // Match the wire date range as well as rejecting overflow/NaN.
        let seconds = until.timeIntervalSince1970
        guard seconds.isFinite, abs(seconds) <= 8_640_000_000_000, until > now else { return nil }
        return until
    }
}

/// The sheet owns the selected identity; a recycled row cannot change its target.
struct FeatureCustomSnoozeSelection: Identifiable, Equatable {
    let id: String
    let title: String

    init(thread: FeatureThread) {
        id = thread.id
        title = thread.title
    }
}

struct FeatureCustomSnoozeSheet: View {
    let selection: FeatureCustomSnoozeSelection
    let onSnooze: (String, Date) -> Void
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var mode = Mode.date
    @State private var date = Date.now.addingTimeInterval(3_600)
    @State private var amount = "1"
    @State private var unit = FeatureCustomSnoozeInput.Unit.hours
    @State private var error: String?

    private enum Mode: String, CaseIterable, Identifiable {
        case date = "Date and time"
        case duration = "Duration"
        var id: Self { self }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(selection.title)
                        .foregroundStyle(T3Colors.textPrimary)
                    Picker("Snooze until", selection: $mode) {
                        ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    if mode == .date {
                        DatePicker("Wake", selection: $date, displayedComponents: [.date, .hourAndMinute])
                            .datePickerStyle(.compact)
                    } else {
                        TextField("Amount", text: $amount)
                            .keyboardType(.decimalPad)
                            .accessibilityLabel("Snooze duration")
                        Picker("Unit", selection: $unit) {
                            ForEach(FeatureCustomSnoozeInput.Unit.allCases) {
                                Text($0.rawValue.capitalized).tag($0)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                .listRowBackground(T3Colors.background)
                if let error {
                    Text(error)
                        .foregroundStyle(.red)
                        .listRowBackground(T3Colors.background)
                        .accessibilityLabel(error)
                }
            }
            .scrollContentBackground(.hidden)
            .background(T3Colors.background)
            .navigationTitle("Custom snooze")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Snooze") { submit() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .presentationDragIndicator(.visible)
        .onChange(of: mode) { error = nil }
        .onChange(of: date) { error = nil }
        .onChange(of: amount) { error = nil }
        .onChange(of: unit) { error = nil }
    }

    private func submit() {
        let input: FeatureCustomSnoozeInput = mode == .date
            ? .date(Calendar.current.dateInterval(of: .minute, for: date)?.start ?? date)
            : .duration(amount: amount, unit: unit)
        guard let until = input.resolve(now: .now) else {
            error = mode == .date
                ? "Choose a date and time in the future." : "Enter a positive duration."
            return
        }
        error = nil
        onSnooze(selection.id, until)
        dismiss()
    }
}
