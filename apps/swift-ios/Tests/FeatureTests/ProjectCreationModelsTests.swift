import Foundation
import Testing
@testable import T3Code

@Suite("Native project creation")
struct ProjectCreationModelsTests {
    @Test
    func repositoryNamesCoverHttpsSshAndProviderPaths() {
        #expect(
            ProjectCreationPath.repositoryName(
                from: "https://github.com/pingdotgg/t3code.git"
            ) == "t3code"
        )
        #expect(
            ProjectCreationPath.repositoryName(
                from: "git@github.com:pingdotgg/t3code.git"
            ) == "t3code"
        )
        #expect(ProjectCreationPath.repositoryName(from: "pingdotgg/t3code") == "t3code")
        #expect(ProjectCreationPath.repositoryName(from: "") == "repository")
    }

    @Test
    func pathsRequireServerAbsoluteOrHomeRelativeInput() throws {
        #expect(try ProjectCreationPath.validated(" ~/work/t3code ").get() == "~/work/t3code")
        #expect(try ProjectCreationPath.validated("/srv/t3code").get() == "/srv/t3code")
        #expect(try ProjectCreationPath.validated(#"C:\work\t3code"#).get() == #"C:\work\t3code"#)
        #expect(ProjectCreationPath.validated("relative/project").isFailure)
        #expect(ProjectCreationPath.validated("  ").isFailure)
    }

    @Test
    func destinationSuggestionsRespectUnixAndWindowsSeparators() {
        #expect(ProjectCreationPath.appending("t3code", to: "~/work") == "~/work/t3code")
        #expect(ProjectCreationPath.appending("t3code", to: "~/work/") == "~/work/t3code")
        #expect(
            ProjectCreationPath.appending("t3code", to: #"C:\work"#) == #"C:\work\t3code"#
        )
        #expect(
            ProjectCreationPath.normalizedForComparison(#"C:\Work\T3Code\"#)
                == "c:/work/t3code"
        )
        #expect(ProjectCreationPath.normalizedForComparison("/srv/App") == "/srv/App")
        #expect(ProjectCreationPath.normalizedForComparison(#"/srv/a\b"#) == #"/srv/a\b"#)
    }

    @Test
    func folderBrowseQueriesNavigateDirectoriesInsteadOfPrefixSearching() {
        #expect(ProjectCreationPath.directoryBrowsePath("~/work") == "~/work/")
        #expect(ProjectCreationPath.directoryBrowsePath("/srv/t3code/") == "/srv/t3code/")
        #expect(
            ProjectCreationPath.directoryBrowsePath(#"C:\work\t3code"#)
                == #"C:\work\t3code\"#
        )

        #expect(ProjectCreationPath.parentBrowsePath(of: "~/work/t3code/") == "~/work/")
        #expect(ProjectCreationPath.parentBrowsePath(of: "~/") == nil)
        #expect(ProjectCreationPath.parentBrowsePath(of: "/srv/t3code/") == "/srv/")
        #expect(ProjectCreationPath.parentBrowsePath(of: "/") == nil)
        #expect(
            ProjectCreationPath.parentBrowsePath(of: #"C:\work\t3code\"#)
                == #"C:\work\"#
        )
        #expect(ProjectCreationPath.parentBrowsePath(of: #"C:\"#) == nil)
        #expect(
            ProjectCreationPath.parentBrowsePath(of: #"\\server\share\folder\"#)
                == #"\\server\share\"#
        )
        #expect(ProjectCreationPath.parentBrowsePath(of: #"\\server\share\"#) == nil)
        #expect(
            ProjectCreationPath.directoryBrowsePath("//server/share/folder")
                == #"\\server\share\folder\"#
        )
    }

    @Test
    func projectTitlesHandleServerPathStyles() {
        #expect(ProjectCreationPath.lastPathComponent("/srv/t3code/") == "t3code")
        #expect(ProjectCreationPath.lastPathComponent(#"C:\work\t3code\"#) == "t3code")
        #expect(ProjectCreationPath.lastPathComponent(#"\\server\share\t3code"#) == "t3code")
    }

    @Test
    func explicitPathsMatchTheConnectedServerFilesystemStyle() {
        #expect(
            ProjectCreationPath.isCompatibleWithServerPath(
                "/srv/t3code",
                serverPath: "/srv"
            )
        )
        #expect(
            !ProjectCreationPath.isCompatibleWithServerPath(
                #"C:\work\t3code"#,
                serverPath: "/srv"
            )
        )
        #expect(
            ProjectCreationPath.isCompatibleWithServerPath(
                #"C:\work\t3code"#,
                serverPath: #"C:\work"#
            )
        )
        #expect(
            ProjectCreationPath.isCompatibleWithServerPath(
                "//server/share/t3code",
                serverPath: #"C:\work"#
            )
        )
        #expect(
            !ProjectCreationPath.isCompatibleWithServerPath(
                "/srv/t3code",
                serverPath: #"C:\work"#
            )
        )
        #expect(
            ProjectCreationPath.isCompatibleWithServerPath(
                "~/work/t3code",
                serverPath: #"C:\Users\theo"#
            )
        )
    }

    @Test
    func discoveryKeepsGitUrlReadyAndGatesProviderAuthentication() {
        let discovery = SourceControlDiscoveryResult(
            versionControlSystems: [],
            sourceControlProviders: [
                SourceControlProviderDiscoveryItem(
                    kind: .github,
                    label: "GitHub",
                    status: .available,
                    version: "2.76",
                    installHint: "Install gh",
                    auth: SourceControlProviderAuth(
                        status: .authenticated,
                        account: "octocat"
                    )
                ),
                SourceControlProviderDiscoveryItem(
                    kind: .gitlab,
                    label: "GitLab",
                    status: .available,
                    installHint: "Install glab",
                    auth: SourceControlProviderAuth(
                        status: .unauthenticated,
                        detail: "Run glab auth login"
                    )
                ),
            ]
        )

        let options = ProjectRemoteSourceOptions.options(discovery: discovery)
        let bySource = Dictionary(uniqueKeysWithValues: options.map { ($0.source, $0) })

        #expect(bySource[.url]?.isReady == true)
        #expect(bySource[.github]?.isReady == true)
        #expect(bySource[.github]?.detail == "Signed in as octocat")
        #expect(bySource[.gitlab]?.isReady == false)
        #expect(bySource[.gitlab]?.detail == "Run glab auth login")
        #expect(bySource[.bitbucket]?.isReady == false)
    }
}

private extension Result {
    var isFailure: Bool {
        if case .failure = self { return true }
        return false
    }
}
