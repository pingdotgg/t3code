import SwiftUI

struct SettingsLicensesView: View {
    @State private var licenses: [NativeLicense] = []
    @State private var search = ""
    @State private var loadFailed = false

    private var filteredLicenses: [NativeLicense] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty ? licenses : licenses.filter {
            $0.name.localizedStandardContains(query)
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if loadFailed {
                    Text("Could not load bundled license notices.")
                        .foregroundStyle(T3Colors.danger)
                        .padding(20)
                } else if !search.isEmpty, filteredLicenses.isEmpty {
                    Text("No matching dependencies.")
                        .foregroundStyle(T3Colors.textSecondary)
                        .padding(20)
                }
                ForEach(filteredLicenses) { license in
                    NavigationLink {
                        LicenseNoticeView(license: license)
                    } label: {
                        HStack(spacing: 12) {
                            Text(license.name)
                                .font(T3Typography.threadBody)
                            Spacer(minLength: 8)
                            Text(license.versionLabel)
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, 14)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider().overlay(T3Colors.separator).padding(.horizontal, 20)
                }
            }
            .padding(.vertical, 8)
        }
        .foregroundStyle(T3Colors.textPrimary)
        .background(T3Colors.background)
        .searchable(text: $search, prompt: "Find a dependency")
        .navigationTitle("Open source licenses")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .task {
            do {
                licenses = try NativeLicenseCatalog.load()
            } catch {
                loadFailed = true
            }
        }
    }
}

private struct LicenseNoticeView: View {
    let license: NativeLicense

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(license.version)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                ForEach(license.notices, id: \.sourceURL) { notice in
                    Link("Source", destination: notice.sourceURL)
                    Text(verbatim: notice.text)
                        .font(T3Typography.supporting)
                        .textSelection(.enabled)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(T3Colors.textPrimary)
        .background(T3Colors.background)
        .navigationTitle(license.name)
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
    }
}
