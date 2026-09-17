import Foundation
import Testing
@testable import T3Code

@Suite("Source control discovery contracts")
struct SourceControlDiscoveryTests {
    @Test
    func decodesEffectOptionsFromTheServerContract() throws {
        let data = Data(
            #"""
            {
              "versionControlSystems": [
                {
                  "kind": "git",
                  "label": "Git",
                  "executable": "git",
                  "implemented": true,
                  "status": "available",
                  "version": {"_id":"Option","_tag":"Some","value":"git 2.50"},
                  "installHint": "Install Git",
                  "detail": {"_id":"Option","_tag":"None"}
                }
              ],
              "sourceControlProviders": [
                {
                  "kind": "github",
                  "label": "GitHub",
                  "executable": "gh",
                  "status": "available",
                  "version": {"_id":"Option","_tag":"Some","value":"2.76"},
                  "installHint": "Install gh",
                  "detail": {"_id":"Option","_tag":"None"},
                  "auth": {
                    "status": "authenticated",
                    "account": {"_id":"Option","_tag":"Some","value":"octocat"},
                    "host": {"_id":"Option","_tag":"Some","value":"github.com"},
                    "detail": {"_id":"Option","_tag":"None"}
                  }
                }
              ]
            }
            """#.utf8
        )

        let result = try JSONDecoder.t3.decode(SourceControlDiscoveryResult.self, from: data)

        #expect(result.versionControlSystems.first?.version == "git 2.50")
        #expect(result.versionControlSystems.first?.detail == nil)
        #expect(result.sourceControlProviders.first?.kind == .github)
        #expect(result.sourceControlProviders.first?.auth.account == "octocat")
        #expect(result.sourceControlProviders.first?.auth.host == "github.com")
        #expect(result.sourceControlProviders.first?.auth.detail == nil)
        #expect(RPCMethod.serverDiscoverSourceControl.rawValue == "server.discoverSourceControl")
    }

    @Test
    func toleratesMissingAndPlainOptionalStrings() throws {
        let data = Data(
            #"""
            {
              "versionControlSystems": [],
              "sourceControlProviders": [
                {
                  "kind": "gitlab",
                  "label": "GitLab",
                  "status": "missing",
                  "version": null,
                  "installHint": "Install glab",
                  "detail": "Not installed",
                  "auth": {
                    "status": "unknown",
                    "account": null,
                    "host": null,
                    "detail": "Not installed"
                  }
                }
              ]
            }
            """#.utf8
        )

        let result = try JSONDecoder.t3.decode(SourceControlDiscoveryResult.self, from: data)
        let provider = try #require(result.sourceControlProviders.first)

        #expect(provider.status == .missing)
        #expect(provider.version == nil)
        #expect(provider.detail == "Not installed")
        #expect(provider.auth.account == nil)
        #expect(provider.auth.detail == "Not installed")
    }
}
