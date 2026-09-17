import Testing
@testable import T3Code

@MainActor
@Suite("Platform account session transitions")
struct PlatformRootViewTests {
    @Test
    func accountSignOutRemovesManagedEnvironments() {
        #expect(PlatformRootView.shouldRemoveManagedEnvironments(
            previousAccountID: "account-1",
            accountID: nil,
            isSigningOut: false
        ))
    }

    @Test
    func changingAccountsRemovesManagedEnvironments() {
        #expect(PlatformRootView.shouldRemoveManagedEnvironments(
            previousAccountID: "account-1",
            accountID: "account-2",
            isSigningOut: false
        ))
    }

    @Test
    func loadingAnExistingAccountKeepsManagedEnvironments() {
        #expect(!PlatformRootView.shouldRemoveManagedEnvironments(
            previousAccountID: nil,
            accountID: "account-1",
            isSigningOut: false
        ))
    }

    @Test
    func unchangedAccountsKeepManagedEnvironments() {
        #expect(!PlatformRootView.shouldRemoveManagedEnvironments(
            previousAccountID: "account-1",
            accountID: "account-1",
            isSigningOut: false
        ))
    }

    @Test
    func explicitSignOutOwnsItsManagedEnvironmentCleanup() {
        #expect(!PlatformRootView.shouldRemoveManagedEnvironments(
            previousAccountID: "account-1",
            accountID: nil,
            isSigningOut: true
        ))
    }
}
