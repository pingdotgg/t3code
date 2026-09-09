import SwiftUI

/// Receipt age shares the idle header row; recovery warnings remain near Retry.
struct FeatureThreadReceiptView: View {
    let receipt: FeatureThreadReceipt

    var body: some View {
        TimelineView(ReceiptAgeSchedule(receivedAt: receipt.receivedAt)) { context in
            Text("Updated \(receipt.relativeAge(at: context.date)) ago")
                .font(T3Typography.navigationMetadata)
                .foregroundStyle(T3Colors.textTertiary)
                .lineLimit(1)
                .accessibilityLabel("Last thread update received at \(receipt.formattedTimestamp())")
        }
        .accessibilityIdentifier("thread-receipt-status")
    }
}

/// Wake only at the next displayed second, minute, hour, or day boundary.
private struct ReceiptAgeSchedule: TimelineSchedule {
    let receivedAt: Date

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnySequence<Date> {
        AnySequence {
            var next = startDate
            return AnyIterator<Date> {
                let date = next
                let age = max(0, date.timeIntervalSince(receivedAt))
                let unit: TimeInterval = age < 60 ? 1 : age < 3_600 ? 60 : age < 86_400 ? 3_600 : 86_400
                next = receivedAt.addingTimeInterval((floor(age / unit) + 1) * unit)
                return date
            }
        }
    }
}
