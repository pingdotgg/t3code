import XCTest
@testable import T3Code

@MainActor
final class NativeContractExpansionTests: XCTestCase {
    func testAdministrativeClientSessionContractsAndRequests() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: EnvironmentCredential(
                accessToken: "bearer",
                scopes: ["access:read", "access:write"]
            ),
        ])
        let transport = AccessHTTPTransport()
        let api = EnvironmentAPI(transport: transport, credentials: credentials)

        let sessions = try await api.clientSessions(for: environment)
        let revoked = try await api.revokeClientSession(
            id: "session-2",
            environment: environment
        )
        let others = try await api.revokeOtherClientSessions(for: environment)

        XCTAssertEqual(sessions.first?.client.label, "Big O")
        XCTAssertEqual(sessions.first?.client.deviceType, "mobile")
        XCTAssertFalse(sessions.first?.current ?? true)
        XCTAssertTrue(revoked.revoked)
        XCTAssertEqual(others.revokedCount, 2)

        let requests = await transport.requests
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/api/auth/clients",
            "/api/auth/clients/revoke",
            "/api/auth/clients/revoke-others",
        ])
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "Bearer bearer"
        })
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Accept-Encoding") == "gzip"
        })
        let revokeBody = try JSONDecoder.t3.decode(
            [String: String].self,
            from: try XCTUnwrap(requests[1].httpBody)
        )
        XCTAssertEqual(revokeBody, ["sessionId": "session-2"])
    }

    func testImageAttachmentBuildsExactTurnUploadShape() throws {
        let image = try UploadChatImageAttachment(
            data: Data([0x89, 0x50, 0x4e, 0x47]),
            name: "screenshot.png",
            mimeType: "image/png"
        )
        let command = try OrchestrationCommands.sendTurn(
            threadID: "thread-1",
            text: "What is in this image?",
            runtimeMode: .fullAccess,
            model: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            attachments: [image],
            commandID: "command-1",
            messageID: "message-1",
            createdAt: "2026-07-30T12:00:00.000Z"
        )

        guard case let .array(attachments)? = command["message"]?["attachments"] else {
            return XCTFail("Expected an attachment array")
        }
        let attachment = try XCTUnwrap(attachments.first)
        XCTAssertEqual(attachment["type"]?.stringValue, "image")
        XCTAssertEqual(attachment["name"]?.stringValue, "screenshot.png")
        XCTAssertEqual(attachment["mimeType"]?.stringValue, "image/png")
        guard case let .number(sizeBytes)? = attachment["sizeBytes"] else {
            return XCTFail("Expected numeric attachment size")
        }
        XCTAssertEqual(sizeBytes, 4)
        XCTAssertEqual(
            attachment["dataUrl"]?.stringValue,
            "data:image/png;base64,iVBORw=="
        )
        XCTAssertEqual(command["modelSelection"]?["instanceId"]?.stringValue, "codex")
    }

    func testImageAttachmentRejectsOversizedInput() {
        XCTAssertThrowsError(
            try UploadChatImageAttachment(
                data: Data(count: UploadChatImageAttachment.maximumBytes + 1),
                name: "huge.png",
                mimeType: "image/png"
            )
        ) { error in
            guard case ImageAttachmentError.tooLarge = error else {
                return XCTFail("Expected size validation, got \(error)")
            }
        }
    }

    func testAssetContractUsesExactTagsAndResultFields() throws {
        XCTAssertEqual(RPCMethod.assetsCreateURL.rawValue, "assets.createUrl")
        XCTAssertEqual(
            AssetResource.attachment(id: "attachment-1").jsonValue["_tag"]?.stringValue,
            "attachment"
        )
        XCTAssertEqual(
            AssetResource.workspaceFile(
                threadID: "thread-1",
                path: "screenshots/app.png"
            ).jsonValue["threadId"]?.stringValue,
            "thread-1"
        )
        let result = try JSONDecoder.t3.decode(
            AssetCreateURLResult.self,
            from: Data(
                """
                {
                  "relativeUrl": "/api/assets/signed/image.png",
                  "expiresAt": 1785466800000
                }
                """.utf8
            )
        )
        XCTAssertEqual(result.relativeUrl, "/api/assets/signed/image.png")
        XCTAssertEqual(result.expiresAt, 1_785_466_800_000)
        XCTAssertEqual(
            RPCMethod.reviewDiffFileContents.rawValue,
            "review.getDiffFileContents"
        )
        let contents = try JSONDecoder.t3.decode(
            ReviewDiffFileContents.self,
            from: Data(#"{"oldContents":"before\n","newContents":"after\n"}"#.utf8)
        )
        XCTAssertEqual(contents.oldContents, "before\n")
        XCTAssertEqual(contents.newContents, "after\n")
    }

    func testServerConfigDecodesFullModelPickerCatalogue() throws {
        let config = try JSONDecoder.t3.decode(
            ServerConfigSnapshot.self,
            from: Data(
                """
                {
                  "settings": {
                    "defaultThreadEnvMode": "worktree",
                    "newWorktreesStartFromOrigin": false
                  },
                  "providers": [{
                    "instanceId": "codex-work",
                    "driver": "codex",
                    "displayName": "Codex",
                    "accentColor": "#10a37f",
                    "badgeLabel": "OpenAI",
                    "showInteractionModeToggle": true,
                    "requiresNewThreadForModelChange": false,
                    "enabled": true,
                    "installed": true,
                    "version": "1.2.3",
                    "status": "ready",
                    "auth": {
                      "status": "authenticated",
                      "type": "chatgpt",
                      "label": "ChatGPT",
                      "email": "theo@example.com"
                    },
                    "checkedAt": "2026-07-30T12:00:00.000Z",
                    "availability": "available",
                    "models": [{
                      "slug": "gpt-5.6-sol",
                      "name": "GPT-5.6 Sol",
                      "shortName": "Sol",
                      "isCustom": false,
                      "isDefault": true,
                      "capabilities": {
                        "optionDescriptors": [{
                          "id": "effort",
                          "type": "select",
                          "label": "Reasoning",
                          "description": "How hard the model thinks.",
                          "options": [{
                            "id": "high",
                            "label": "High",
                            "isDefault": true
                          }],
                          "currentValue": "high"
                        }, {
                          "id": "fastMode",
                          "type": "boolean",
                          "label": "Fast mode",
                          "currentValue": true
                        }]
                      }
                    }, {
                      "slug": "gpt-5.6-terra",
                      "name": "GPT-5.6 Terra",
                      "shortName": "Terra",
                      "isCustom": false,
                      "isDefault": false,
                      "isLegacy": true,
                      "capabilities": null
                    }],
                    "slashCommands": [{
                      "name": "review",
                      "description": "Review the current changes",
                      "input": { "hint": "focus" }
                    }],
                    "skills": [{
                      "name": "gh-fix-ci",
                      "description": "Fix CI failures",
                      "path": "/skills/gh-fix-ci/SKILL.md",
                      "scope": "user",
                      "enabled": true,
                      "displayName": "Fix CI",
                      "shortDescription": "Debug GitHub Actions"
                    }]
                  }]
                }
                """.utf8
            )
        )

        let provider = try XCTUnwrap(config.providers.first)
        XCTAssertEqual(provider.instanceId, "codex-work")
        XCTAssertEqual(provider.auth.status, "authenticated")
        XCTAssertEqual(provider.models.map(\.slug), ["gpt-5.6-sol", "gpt-5.6-terra"])
        XCTAssertEqual(provider.slashCommands?.first?.name, "review")
        XCTAssertEqual(provider.slashCommands?.first?.input?.hint, "focus")
        XCTAssertEqual(provider.skills?.first?.displayName, "Fix CI")
        XCTAssertEqual(config.settings?.defaultThreadEnvMode, .worktree)
        XCTAssertEqual(config.settings?.newWorktreesStartFromOrigin, false)
        let model = try XCTUnwrap(provider.models.first)
        XCTAssertEqual(model.slug, "gpt-5.6-sol")
        XCTAssertNil(model.isLegacy)
        XCTAssertEqual(provider.models[1].isLegacy, true)
        let descriptors = try XCTUnwrap(model.capabilities?.optionDescriptors)
        guard case let .select(effort) = descriptors[0],
              case let .boolean(fastMode) = descriptors[1]
        else {
            return XCTFail("Expected typed select and boolean descriptors")
        }
        XCTAssertEqual(effort.options.first?.label, "High")
        XCTAssertEqual(effort.currentValue, "high")
        XCTAssertEqual(fastMode.currentValue, true)
    }

    func testServerConfigSettingsUpdateDecodesEnvironmentPreferences() throws {
        let event = try JSONDecoder.t3.decode(
            ServerConfigStreamEvent.self,
            from: Data(
                """
                {
                  "version": 1,
                  "type": "settingsUpdated",
                  "payload": {
                    "settings": {
                      "defaultThreadEnvMode": "worktree",
                      "newWorktreesStartFromOrigin": false
                    }
                  }
                }
                """.utf8
            )
        )

        guard case let .settingsUpdated(settings) = event else {
            return XCTFail("Expected a settings update")
        }
        XCTAssertEqual(settings.defaultThreadEnvMode, .worktree)
        XCTAssertFalse(settings.newWorktreesStartFromOrigin)
    }

    func testProviderArraysDropOnlyUnknownProviderEntries() throws {
        let providers = """
        [{
          "instanceId": "future-provider",
          "driver": "future",
          "enabled": true,
          "installed": true,
          "status": "ready",
          "auth": { "status": "authenticated" },
          "checkedAt": "2026-08-04T12:00:00.000Z",
          "models": [{
            "slug": "future-model",
            "name": "Future",
            "isCustom": false,
            "capabilities": {
              "optionDescriptors": [{ "type": "future-option" }]
            }
          }]
        }, {
          "instanceId": "codex",
          "driver": "codex",
          "enabled": true,
          "installed": true,
          "status": "ready",
          "auth": { "status": "authenticated" },
          "checkedAt": "2026-08-04T12:00:00.000Z",
          "models": [{
            "slug": "gpt-5.6-sol",
            "name": "GPT-5.6 Sol",
            "isCustom": false,
            "isLegacy": false
          }]
        }]
        """
        let snapshot = try JSONDecoder.t3.decode(
            ServerConfigSnapshot.self,
            from: Data(
                """
                {
                  "providers": \(providers),
                  "settings": {
                    "defaultThreadEnvMode": "worktree",
                    "newWorktreesStartFromOrigin": false
                  }
                }
                """.utf8
            )
        )

        XCTAssertEqual(snapshot.providers.map(\.instanceId), ["codex"])
        XCTAssertEqual(snapshot.settings?.defaultThreadEnvMode, .worktree)

        let event = try JSONDecoder.t3.decode(
            ServerConfigStreamEvent.self,
            from: Data(
                """
                {
                  "type": "providerStatuses",
                  "payload": { "providers": \(providers) }
                }
                """.utf8
            )
        )
        guard case let .providerStatuses(decodedProviders) = event else {
            return XCTFail("Expected provider statuses")
        }
        XCTAssertEqual(decodedProviders.map(\.instanceId), ["codex"])
    }
}

private actor AccessHTTPTransport: HTTPTransport {
    private(set) var requests: [URLRequest] = []

    func data(for request: URLRequest) -> (Data, HTTPURLResponse) {
        requests.append(request)
        let body: String
        switch request.url?.path {
        case "/api/auth/clients":
            body = """
            [{
              "sessionId": "session-2",
              "subject": "paired-client",
              "scopes": ["orchestration:read"],
              "method": "bearer-access-token",
              "client": {
                "label": "Big O",
                "ipAddress": "192.168.1.10",
                "deviceType": "mobile",
                "os": "iOS"
              },
              "issuedAt": "2026-07-30T12:00:00.000Z",
              "expiresAt": "2026-08-30T12:00:00.000Z",
              "lastConnectedAt": "2026-07-30T12:05:00.000Z",
              "connected": true,
              "current": false
            }]
            """
        case "/api/auth/clients/revoke":
            body = #"{"revoked":true}"#
        case "/api/auth/clients/revoke-others":
            body = #"{"revokedCount":2}"#
        default:
            body = "{}"
        }
        return (
            Data(body.utf8),
            HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
        )
    }
}
