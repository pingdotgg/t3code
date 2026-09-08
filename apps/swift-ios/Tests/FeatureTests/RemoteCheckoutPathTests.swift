import Testing
@testable import T3Code

@Suite("Remote checkout path comparison")
struct RemoteCheckoutPathTests {
    @Test(arguments: [
        (#"C:\Work\T3Code"#, "c:/work/t3code"),
        (#"C:\Work\T3Code\"#, #"C:\Work\T3Code"#),
        (#"\\server\share\repo"#, "//SERVER/share/repo"),
        (#"C:\"#, "c:/"),
        (#"\\SERVER\Share\"#, "//server/share"),
        ("/repo/./", "/repo"),
        ("/work/other/../repo", "/work/repo"),
    ])
    func equivalentRootsUseCurrentCheckout(_ checkout: String, _ project: String) {
        let branch = FeatureWorkspaceBranch(name: "main", worktreePath: checkout)
        #expect(NewTaskWorkspaceDefaults.normalizedWorktreePath(for: branch, projectPath: project) == nil)
    }

    @Test(arguments: [
        ("/srv/linked/../repo", "/srv/repo"),
        (#"C:\linked\..\repo"#, "c:/repo"),
    ])
    func projectDeduplicationPreservesUnresolvedParentSegments(_ input: String, _ other: String) {
        #expect(ProjectCreationPath.normalizedForComparison(input)
            != ProjectCreationPath.normalizedForComparison(other))
    }

    @Test(arguments: [
        (#"C:\linked\..\repo"#, "c:/repo"),
        (#"D:\work\repo"#, #"C:\work\repo"#),
        (#"\\server\other\repo"#, #"\\server\share\repo"#),
        (#"D:\"#, "c:/"),
        (#"\\server\other\"#, "//server/share"),
        (#"C:\repo\."#, "c:/repo"),
        (#"\\server\share\."#, "//server/share"),
        (#"\\server\share\..\repo"#, "//server/repo"),
        ("/srv/App", "/srv/app"),
        ("//srv/Work", "//srv/work"),
        ("//srv/work", "//srv/Work"),
        (#"/srv/a\b"#, "/srv/a/b"),
        (#"C:\work\linked"#, #"C:\work\repo"#),
    ])
    func distinctWorktreesPreserveServerSpelling(_ checkout: String, _ project: String) {
        let branch = FeatureWorkspaceBranch(name: "linked", worktreePath: checkout)
        #expect(NewTaskWorkspaceDefaults.normalizedWorktreePath(for: branch, projectPath: project) == checkout)
    }
}
