import SwiftUI

/// A static receipt time stays honest when a connected thread is quiet.
struct FeatureThreadReceiptView: View {
    let receipt: FeatureThreadReceipt?
    let connectionState: FeatureConnection.State?
    let syncState: FeatureThreadSyncState?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            connectionLabel
            if let receipt {
                if receipt.source == .detailSnapshot {
                    Text("Snapshot received \(receipt.formattedTimestamp())")
                        .accessibilityLabel(Text("Thread snapshot received at \(receipt.formattedTimestamp())"))
                } else {
                    Text("Last update received \(receipt.formattedTimestamp())")
                        .accessibilityLabel(Text("Last thread update received at \(receipt.formattedTimestamp())"))
                }
            } else {
                Text("No receipt time available")
            }
        }
        .font(T3Typography.supporting)
        .foregroundStyle(T3Colors.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18)
        .padding(.vertical, 6)
        .background(T3Colors.background)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread-receipt-status")
    }

    @ViewBuilder
    private var connectionLabel: some View {
        switch connectionState {
        case .disconnected: Text("Disconnected")
        case .connecting: Text("Connecting")
        case .reconnecting: Text("Reconnecting")
        case nil: Text("Connection status unavailable")
        case .connected:
            switch syncState {
            case .reconnecting: Text("Connected · reconnecting thread updates")
            case .catchingUp: Text("Connected · catching up")
            case .failed: Text("Connected · thread updates unavailable")
            case .live, nil: Text("Connected")
            }
        }
    }
}
