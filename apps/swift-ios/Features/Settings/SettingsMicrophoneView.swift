import AVFoundation
import SwiftUI
import UIKit

struct SettingsMicrophoneView: View {
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @SwiftUI.Environment(\.openURL) private var openURL
    @State private var preferences = FeatureMicrophonePreferences.shared
    @State private var permission = AVAudioApplication.shared.recordPermission
    @State private var isRequestingPermission = false

    var body: some View {
        List {
            if permission != .granted {
                Section {
                    Button(permission == .denied ? "Open Settings" : "Allow microphone access") {
                        if permission == .denied {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                openURL(url)
                            }
                        } else {
                            Task { await requestPermission() }
                        }
                    }
                    .disabled(isRequestingPermission)
                    .listRowBackground(T3Colors.background)
                } header: {
                    Text("Microphone access")
                } footer: {
                    Text(permission == .denied
                         ? "Microphone access is off for T3 Code. Turn it on in Settings to use voice input."
                         : "Voice input needs microphone access before it can record or list your microphones.")
                }
            }

            Section {
                ForEach(preferences.entries) { entry in
                    HStack(spacing: 12) {
                        Image(systemName: entry.microphoneKind.symbol)
                            .frame(width: 22)
                            .foregroundStyle(T3Colors.textSecondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.deviceName ?? entry.microphoneKind.rowTitle)
                                .font(T3Typography.threadBody)
                            Text(entry.deviceUID == nil
                                 ? entry.microphoneKind.rowDescription : entry.microphoneKind.label)
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                        .padding(.vertical, 6)
                    }
                    .accessibilityElement(children: .combine)
                    .deleteDisabled(entry.deviceUID == nil)
                    .listRowBackground(T3Colors.background)
                }
                .onMove { source, destination in
                    var entries = preferences.entries
                    entries.move(fromOffsets: source, toOffset: destination)
                    preferences.update(entries)
                }
                .onDelete { offsets in
                    var entries = preferences.entries
                    entries.remove(atOffsets: offsets)
                    preferences.update(entries)
                }
            } header: {
                Text("Preferred order")
            } footer: {
                Text("Voice input uses the first connected microphone in this list. Wired and Bluetooth devices are added by name when you use voice input with them connected. Until then, the Other row ranks them. Use Edit to reorder or forget devices.")
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .foregroundStyle(T3Colors.textPrimary)
        .background(T3Colors.background)
        .tint(T3Colors.accent)
        .navigationTitle("Microphone")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .toolbar { EditButton() }
        .onAppear { refreshPermission() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { refreshPermission() }
        }
    }

    private func refreshPermission() {
        permission = AVAudioApplication.shared.recordPermission
    }

    @MainActor
    private func requestPermission() async {
        guard !isRequestingPermission else { return }
        isRequestingPermission = true
        _ = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
        refreshPermission()
        isRequestingPermission = false
    }
}

private extension FeatureMicrophoneKind {
    var label: String {
        switch self {
        case .wired: "Wired"
        case .bluetooth: "Bluetooth"
        case .builtIn: "Built-in"
        case .carPlay: "CarPlay"
        }
    }

    var rowTitle: String {
        switch self {
        case .wired: "Other wired"
        case .bluetooth: "Other Bluetooth"
        case .builtIn: "Built-in microphone"
        case .carPlay: "CarPlay"
        }
    }

    var rowDescription: String {
        switch self {
        case .wired: "Headsets and USB microphones not listed"
        case .bluetooth: "AirPods, headsets, and cars not listed"
        case .builtIn: "The microphone on this device"
        case .carPlay: "The car’s microphone"
        }
    }

    var symbol: String {
        switch self {
        case .wired: "cable.connector"
        case .bluetooth: "headphones"
        case .builtIn: "iphone"
        case .carPlay: "car"
        }
    }
}
