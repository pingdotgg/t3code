import SwiftUI

public struct FeatureEnvironmentRoutes: Sendable, Equatable {
    public let routes: [EnvironmentRoute]
    public let activeRouteID: String?

    public init(routes: [EnvironmentRoute], activeRouteID: String?) {
        self.routes = routes
        self.activeRouteID = activeRouteID
    }
}

@MainActor
public protocol FeatureEnvironmentRoutesManaging: AnyObject {
    func managedOnlyEnvironmentIDs() async throws -> [String]
    func removeManagedEnvironmentRoutes() async throws
    func environmentRoutes(environmentID: String) async throws -> FeatureEnvironmentRoutes
    func addEnvironmentRoute(environmentID: String, pairingURL: String) async throws
    func reorderEnvironmentRoutes(environmentID: String, routeIDs: [String]) async throws
    func removeEnvironmentRoute(environmentID: String, routeID: String) async throws
}

struct EnvironmentRoutesView: View {
    let environmentID: String
    let manager: any FeatureEnvironmentRoutesManaging
    @State private var snapshot: FeatureEnvironmentRoutes?
    @State private var errorMessage: String?
    @State private var isSaving = false
    @State private var showingAdd = false
    @State private var removalTarget: EnvironmentRoute?

    var body: some View {
        List {
            Section {
                ForEach(snapshot?.routes ?? []) { route in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(route.label).foregroundStyle(T3Colors.textPrimary)
                                if snapshot?.activeRouteID == route.id {
                                    Text("In use").foregroundStyle(T3Colors.success)
                                }
                            }
                            Text(route.httpBaseURL.absoluteString)
                                .textSelection(.enabled)
                                .foregroundStyle(T3Colors.textSecondary)
                            if route.isLearned {
                                Text("Found automatically").foregroundStyle(T3Colors.textSecondary)
                            }
                        }
                        Spacer(minLength: 4)
                    }
                    .font(T3Typography.supporting)
                    .contextMenu {
                        Button("Move up", systemImage: "arrow.up") { move(route, by: -1) }
                            .disabled(!canMove(route, by: -1))
                        Button("Move down", systemImage: "arrow.down") { move(route, by: 1) }
                            .disabled(!canMove(route, by: 1))
                        if canRemove(route) {
                            Button("Remove route", systemImage: "trash", role: .destructive) { removalTarget = route }
                        }
                    }
                    .accessibilityAction(named: "Move up") { if canMove(route, by: -1) { move(route, by: -1) } }
                    .accessibilityAction(named: "Move down") { if canMove(route, by: 1) { move(route, by: 1) } }
                    .swipeActions {
                        if canRemove(route) {
                            Button("Remove", role: .destructive) { removalTarget = route }
                        }
                    }
                }
                .onMove { offsets, destination in
                    guard var routes = snapshot?.routes else { return }
                    routes.move(fromOffsets: offsets, toOffset: destination)
                    reorder(routes.map(\.id))
                }
                Button("Add route", systemImage: "plus") { showingAdd = true }
            } footer: {
                Text("Routes are tried in this order. Add a pairing link for another address on this environment.")
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(T3Colors.danger) }
            }
        }
        .disabled(isSaving)
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("Routes")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { EditButton() }
        .task { await reload() }
        .refreshable { await reload() }
        .sheet(isPresented: $showingAdd) {
            AddEnvironmentRouteView(environmentID: environmentID, manager: manager) { await reload() }
        }
        .confirmationDialog(
            "Remove this route?",
            isPresented: Binding(get: { removalTarget != nil }, set: { if !$0 { removalTarget = nil } }),
            titleVisibility: .visible
        ) {
            if let route = removalTarget {
                Button("Remove route", role: .destructive) {
                    mutate { try await manager.removeEnvironmentRoute(environmentID: environmentID, routeID: route.id) }
                    removalTarget = nil
                }
            }
        } message: {
            Text("Automatically found routes that use this pairing will also be removed.")
        }
    }

    private func canRemove(_ route: EnvironmentRoute) -> Bool {
        !route.isLearned && (snapshot?.routes.contains {
            $0.id != route.id && (!$0.isLearned || $0.credentialOwnerID != route.credentialOwnerID)
        } ?? false)
    }

    private func canMove(_ route: EnvironmentRoute, by offset: Int) -> Bool {
        guard let routes = snapshot?.routes, let index = routes.firstIndex(where: { $0.id == route.id }) else { return false }
        return routes.indices.contains(index + offset)
    }

    private func move(_ route: EnvironmentRoute, by offset: Int) {
        guard var routes = snapshot?.routes, let index = routes.firstIndex(where: { $0.id == route.id }),
              routes.indices.contains(index + offset) else { return }
        routes.swapAt(index, index + offset)
        reorder(routes.map(\.id))
    }

    private func reorder(_ ids: [String]) {
        mutate { try await manager.reorderEnvironmentRoutes(environmentID: environmentID, routeIDs: ids) }
    }

    private func mutate(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        Task {
            defer { isSaving = false }
            do { try await operation(); await reload() }
            catch { errorMessage = error.localizedDescription }
        }
    }

    private func reload() async {
        do { snapshot = try await manager.environmentRoutes(environmentID: environmentID); errorMessage = nil }
        catch { errorMessage = error.localizedDescription }
    }
}

private struct AddEnvironmentRouteView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let environmentID: String
    let manager: any FeatureEnvironmentRoutesManaging
    let onAdded: @MainActor () async -> Void
    @State private var pairingURL = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Pairing link", text: $pairingURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } footer: {
                    Text("Create a new pairing link on this environment, then paste it here.")
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(T3Colors.danger) }
            }
            .disabled(isSaving)
            .scrollContentBackground(.hidden)
            .background(T3Colors.background)
            .navigationTitle("Add route")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Adding…" : "Add") {
                        isSaving = true
                        Task {
                            defer { isSaving = false }
                            do {
                                try await manager.addEnvironmentRoute(environmentID: environmentID, pairingURL: pairingURL)
                                await onAdded()
                                dismiss()
                            } catch { errorMessage = error.localizedDescription }
                        }
                    }
                    .disabled(isSaving || pairingURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(isSaving)
        }
    }
}
