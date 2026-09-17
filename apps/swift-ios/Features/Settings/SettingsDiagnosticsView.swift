import SwiftUI

struct SettingsDiagnosticsView: View {
    private let diagnostics = NativeDiagnostics.shared
    @State private var confirmingClear = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Crash and slow-launch reports from iOS. Reports can arrive on a later launch. An empty list does not mean the app never crashed.")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)

                if let error = diagnostics.storageError {
                    Text(error).foregroundStyle(T3Colors.danger)
                }
                if diagnostics.reports.isEmpty {
                    Text("No reports received.")
                        .foregroundStyle(T3Colors.textSecondary)
                }
                ForEach(diagnostics.reports) { report in
                    NavigationLink {
                        DiagnosticReportView(report: report)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(report.title)
                                .font(T3Typography.threadBody)
                            Text(report.periodEnd.formatted(date: .abbreviated, time: .shortened))
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider().overlay(T3Colors.separator)
                }
                if !diagnostics.reports.isEmpty || diagnostics.storageError != nil {
                    Button("Clear saved reports", role: .destructive) {
                        confirmingClear = true
                    }
                }
            }
            .padding(20)
        }
        .foregroundStyle(T3Colors.textPrimary)
        .background(T3Colors.background)
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .confirmationDialog("Clear saved reports?", isPresented: $confirmingClear) {
            Button("Clear reports", role: .destructive) { diagnostics.clear() }
        } message: {
            Text("This removes up to five saved reports from this device.")
        }
    }
}

private struct DiagnosticReportView: View {
    let report: NativeDiagnosticReport
    @State private var copied = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Reporting period: \(report.periodStart.formatted()) to \(report.periodEnd.formatted())")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                if let json = report.json {
                    Text("Review before sharing. Reports can include app exception details.")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                    HStack(spacing: 24) {
                        Button {
                            UIPasteboard.general.string = json
                            copied = true
                        } label: {
                            Label(copied ? "Copied" : "Copy report", systemImage: "doc.on.doc")
                        }
                        ShareLink(item: json) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                    }
                    Text(verbatim: json)
                        .font(T3Typography.code)
                        .textSelection(.enabled)
                } else {
                    Text("This report exceeded the 256 KB limit. Only its reporting period was saved.")
                        .font(T3Typography.supporting)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(T3Colors.textPrimary)
        .background(T3Colors.background)
        .navigationTitle(report.title)
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
    }
}
