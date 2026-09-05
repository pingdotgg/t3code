import XCTest
@testable import T3Code

@MainActor
final class TransportReliabilityTests: XCTestCase {
    func testMobileClientMetadataIncludesOSVersionAndDeviceModel() {
        XCTAssertGreaterThan(MobileClientMetadata.osMajorVersion, 0)
        XCTAssertFalse(MobileClientMetadata.deviceModel.isEmpty)
    }

    func testHTTPPolicyOffersGzipWithoutOverwritingCallerPreference() {
        var request = URLRequest(url: URL(string: "https://studio.example/api")!)
        let prepared = HTTPRequestPolicy.prepare(request)
        XCTAssertEqual(prepared.value(forHTTPHeaderField: "Accept-Encoding"), "gzip")
        XCTAssertEqual(prepared.value(forHTTPHeaderField: "Accept"), "application/json")

        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        XCTAssertEqual(
            HTTPRequestPolicy.prepare(request).value(forHTTPHeaderField: "Accept-Encoding"),
            "identity"
        )
    }

    func testEnvironmentAPIDecodesURLSessionDecompressedGzipResponse() async throws {
        let transport = RecordingHTTPTransport { request in
            let body = """
            {
              "environmentId": "environment-1",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": {"repositoryIdentity": true}
            }
            """
            return (
                Data(body.utf8),
                transportResponse(
                    request,
                    headers: [
                        "Content-Type": "application/json",
                        // URLSession retains this response header while
                        // returning the already decompressed body.
                        "Content-Encoding": "gzip",
                    ]
                )
            )
        }
        let api = EnvironmentAPI(
            transport: transport,
            credentials: InMemoryCredentialStore()
        )

        let descriptor = try await api.descriptor(
            at: URL(string: "https://studio.example")!
        )
        XCTAssertEqual(descriptor.environmentId, "environment-1")
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept-Encoding"), "gzip")
    }

    func testShellSnapshotAppliesBoundedStartupTimeout() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]
        )
        let transport = RecordingHTTPTransport { request in
            let body = #"{"snapshotSequence":0,"projects":[],"threads":[],"updatedAt":"2026-08-05T12:00:00.000Z"}"#
            return (Data(body.utf8), transportResponse(request))
        }
        let api = EnvironmentAPI(transport: transport, credentials: credentials)

        _ = try await api.shellSnapshot(for: environment, timeoutInterval: 6)

        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.timeoutInterval, 6)
    }

    func testThreadSnapshotSendsPaginationWindowAndDecodesCursor() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: EnvironmentCredential(accessToken: "access-token"),
        ])
        let body = try JSONEncoder.t3.encode(
            OrchestrationThreadDetailSnapshot(
                snapshotSequence: 42,
                thread: paginationThreadFixture(),
                page: OrchestrationThreadDetailPage(
                    beforeCursor: "next-cursor",
                    hasMore: true,
                    snapshotSequence: 42,
                    threadSequence: 40
                )
            )
        )
        let transport = RecordingHTTPTransport { request in
            (body, transportResponse(request))
        }
        let api = EnvironmentAPI(transport: transport, credentials: credentials)

        let snapshot = try await api.threadSnapshot(
            id: "thread-1",
            environment: environment,
            turnLimit: 20,
            beforeCursor: "current-cursor"
        )

        XCTAssertEqual(snapshot.page?.beforeCursor, "next-cursor")
        XCTAssertEqual(snapshot.page?.threadSequence, 40)
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        let query = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            .queryItems
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: (query ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            }),
            ["turnLimit": "20", "beforeCursor": "current-cursor"]
        )
    }

    func testWebSocketHandshakeOffersPerMessageDeflate() {
        let url = URL(string: "wss://studio.example/ws?wsTicket=secret")!
        let compressed = WebSocketHandshakeRequest.make(url: url)
        XCTAssertEqual(
            compressed.value(forHTTPHeaderField: "Sec-WebSocket-Extensions"),
            "permessage-deflate; client_max_window_bits"
        )
        XCTAssertNil(
            WebSocketHandshakeRequest.make(
                url: url,
                offersPerMessageDeflate: false
            ).value(forHTTPHeaderField: "Sec-WebSocket-Extensions")
        )
    }

    func testBootstrapUsesCanonicalWebSocketRPCDispatch() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]
        )
        let transport = RecordingHTTPTransport { request in
            let body = """
            {
              "ticket": "websocket-ticket",
              "expiresAt": "2026-07-30T12:05:00.000Z"
            }
            """
            return (Data(body.utf8), transportResponse(request))
        }
        let connection = RecordingWebSocketConnection()
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: StaticWebSocketConnector(connection: connection)
        )

        let result = try await client.createThreadAndSend(
            threadID: "thread-first-send",
            projectID: "project-1",
            title: "Native first send",
            text: "Start from this message",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
            runtimeMode: .fullAccess,
            commandID: "stable-command",
            messageID: "stable-message",
            createdAt: "2026-07-30T12:00:00.000Z"
        )
        await client.disconnect()

        XCTAssertEqual(result.sequence, 42)
        let requests = await connection.requests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?["tag"]?.stringValue, "orchestration.dispatchCommand")
        XCTAssertEqual(
            requests.first?["payload"]?["bootstrap"]?["createThread"]?["projectId"]?.stringValue,
            "project-1"
        )
        XCTAssertEqual(requests.first?["payload"]?["commandId"]?.stringValue, "stable-command")
        XCTAssertEqual(
            requests.first?["payload"]?["message"]?["messageId"]?.stringValue,
            "stable-message"
        )

        let httpRequests = await transport.requests
        XCTAssertEqual(httpRequests.map(\.url?.path), ["/api/auth/websocket-ticket"])

        let socketURLs = await connection.connectionURLs()
        let socketURL = try XCTUnwrap(socketURLs.first)
        let metadata = Dictionary(
            uniqueKeysWithValues: (URLComponents(url: socketURL, resolvingAgainstBaseURL: false)?
                .queryItems ?? []).compactMap { item in
                    item.value.map { (item.name, $0) }
                }
        )
        XCTAssertEqual(metadata["clientSurface"], "mobile")
        XCTAssertEqual(metadata["clientOs"], "iOS")
        XCTAssertEqual(metadata["clientOsMajorVersion"], String(MobileClientMetadata.osMajorVersion))
        XCTAssertEqual(metadata["clientDeviceModel"], MobileClientMetadata.deviceModel)
    }

    func testModernServersUploadImageBytesBeforeDispatchingTheTurn() async throws {
        let descriptor = try JSONDecoder.t3.decode(
            EnvironmentDescriptor.self,
            from: Data(
                """
                {
                  "environmentId": "environment-1",
                  "label": "Studio",
                  "platform": {"os": "darwin", "arch": "arm64"},
                  "serverVersion": "1.0.0",
                  "capabilities": {"attachmentUploads": true}
                }
                """.utf8
            )
        )
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!,
            descriptor: descriptor
        )
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: EnvironmentCredential(accessToken: "access-token"),
        ])
        let transport = RecordingHTTPTransport { request in
            if request.url?.path == "/api/auth/websocket-ticket" {
                return (
                    Data(#"{"ticket":"websocket-ticket","expiresAt":"2026-07-30T12:05:00.000Z"}"#.utf8),
                    transportResponse(request)
                )
            }
            return (Data(), transportResponse(request, status: 204))
        }
        let connection = RecordingWebSocketConnection()
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: StaticWebSocketConnector(connection: connection)
        )
        let image = try UploadChatImageAttachment(
            data: Data([0x89, 0x50, 0x4e, 0x47]),
            name: "screenshot.png",
            mimeType: "image/png"
        )

        _ = try await client.createThreadAndSend(
            threadID: "thread-1",
            projectID: "project-1",
            title: "Image task",
            text: "Inspect this image",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            attachments: [image]
        )
        await client.disconnect()

        let socketRequests = await connection.requests()
        XCTAssertEqual(socketRequests.map { $0["tag"]?.stringValue }, [
            "attachments.createUploadUrl",
            "orchestration.dispatchCommand",
        ])
        XCTAssertEqual(
            socketRequests[0]["payload"]?["sizeBytes"],
            .number(4)
        )
        guard case let .array(attachments)? = socketRequests[1]["payload"]?["message"]?["attachments"],
              let attachment = attachments.first else {
            return XCTFail("Expected an uploaded attachment")
        }
        XCTAssertEqual(attachment["id"]?.stringValue, "uploaded-attachment-1")
        XCTAssertNil(attachment["dataUrl"])

        let httpRequests = await transport.requests
        XCTAssertEqual(httpRequests.map(\.url?.path), [
            "/api/auth/websocket-ticket",
            "/api/attachments/upload/signed-token",
        ])
        XCTAssertEqual(httpRequests[1].httpBody, Data([0x89, 0x50, 0x4e, 0x47]))
        XCTAssertNil(httpRequests[1].value(forHTTPHeaderField: "Authorization"))
    }

    func testOlderServersKeepInlineImageAttachments() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: EnvironmentCredential(accessToken: "access-token"),
        ])
        let transport = RecordingHTTPTransport { request in
            (
                Data(#"{"ticket":"websocket-ticket","expiresAt":"2026-07-30T12:05:00.000Z"}"#.utf8),
                transportResponse(request)
            )
        }
        let connection = RecordingWebSocketConnection()
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: StaticWebSocketConnector(connection: connection)
        )
        let image = try UploadChatImageAttachment(
            data: Data([0x89, 0x50, 0x4e, 0x47]),
            name: "screenshot.png",
            mimeType: "image/png"
        )

        _ = try await client.createThreadAndSend(
            threadID: "thread-1",
            projectID: "project-1",
            title: "Image task",
            text: "Inspect this image",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            attachments: [image]
        )
        await client.disconnect()

        let requests = await connection.requests()
        XCTAssertEqual(requests.map { $0["tag"]?.stringValue }, ["orchestration.dispatchCommand"])
        guard case let .array(attachments)? = requests[0]["payload"]?["message"]?["attachments"] else {
            return XCTFail("Expected an inline image")
        }
        XCTAssertEqual(attachments.first?["dataUrl"]?.stringValue, "data:image/png;base64,iVBORw==")
    }

    func testExpiredSavedAttachmentIsUploadedAgain() async throws {
        let descriptor = try attachmentDescriptor(
            #"{"attachmentUploads":true,"fileAttachments":{"maxUploadBytes":52428800}}"#
        )
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!,
            descriptor: descriptor
        )
        let transport = RecordingHTTPTransport { request in
            if request.url?.path == "/api/auth/websocket-ticket" {
                return (
                    Data(#"{"ticket":"ticket","expiresAt":"2026-07-30T12:05:00.000Z"}"#.utf8),
                    transportResponse(request)
                )
            }
            return (Data(), transportResponse(request, status: 204))
        }
        let socket = RecordingWebSocketConnection(
            assetErrorMessage: "Attachment saved-id was not found."
        )
        let client = T3Client(
            environment: environment,
            credentialStore: InMemoryCredentialStore(credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]),
            httpTransport: transport,
            webSocketConnector: StaticWebSocketConnector(connection: socket)
        )
        let attachment = try UploadChatAttachment(
            data: Data([1]),
            name: "image.png",
            mimeType: "image/png",
            uploadedReference: .init(
                environmentID: environment.id,
                attachmentID: "saved-id"
            )
        )

        let reference = try await client.prepareAttachment(attachment)
        await client.disconnect()

        XCTAssertEqual(reference?.attachmentID, "uploaded-attachment-1")
        let requests = await socket.requests()
        XCTAssertEqual(requests.map { $0["tag"]?.stringValue }, [
            "assets.createUrl",
            "attachments.createUploadUrl",
        ])
    }

    func testSavedAttachmentAuthErrorDoesNotUploadAgain() async throws {
        let descriptor = try attachmentDescriptor(#"{"attachmentUploads":true}"#)
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!,
            descriptor: descriptor
        )
        let transport = RecordingHTTPTransport { request in
            (
                Data(#"{"ticket":"ticket","expiresAt":"2026-07-30T12:05:00.000Z"}"#.utf8),
                transportResponse(request)
            )
        }
        let socket = RecordingWebSocketConnection(assetErrorMessage: "Unauthorized")
        let client = T3Client(
            environment: environment,
            credentialStore: InMemoryCredentialStore(credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]),
            httpTransport: transport,
            webSocketConnector: StaticWebSocketConnector(connection: socket)
        )
        let attachment = try UploadChatAttachment(
            data: Data([1]),
            name: "image.png",
            mimeType: "image/png",
            uploadedReference: .init(
                environmentID: environment.id,
                attachmentID: "saved-id"
            )
        )

        do {
            _ = try await client.prepareAttachment(attachment)
            XCTFail("Expected the authorization error")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("Unauthorized"))
        }
        await client.disconnect()
        let requests = await socket.requests()
        XCTAssertEqual(requests.map { $0["tag"]?.stringValue }, [
            "assets.createUrl",
        ])
    }

    func testUploadFailureReturnsBeforeBestEffortCleanupCompletes() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!,
            descriptor: try attachmentDescriptor(#"{"attachmentUploads":true}"#)
        )
        let transport = RecordingHTTPTransport { request in
            if request.url?.path == "/api/auth/websocket-ticket" {
                return (
                    Data(#"{"ticket":"ticket","expiresAt":"2026-07-30T12:05:00.000Z"}"#.utf8),
                    transportResponse(request)
                )
            }
            return (
                Data("Upload rejected".utf8),
                transportResponse(request, status: 503)
            )
        }
        let socket = RecordingWebSocketConnection(holdAttachmentDeletion: true)
        let client = T3Client(
            environment: environment,
            credentialStore: InMemoryCredentialStore(credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]),
            httpTransport: transport,
            webSocketConnector: StaticWebSocketConnector(connection: socket)
        )
        let image = try UploadChatAttachment(
            data: Data([1]), name: "image.png", mimeType: "image/png"
        )
        let failed = XCTestExpectation(description: "Upload failure returned")
        let preparation = Task {
            do {
                _ = try await client.prepareAttachment(image)
                XCTFail("Expected the upload error")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("Upload rejected"))
            }
            failed.fulfill()
        }

        await socket.waitForAttachmentDeletion()
        let result = await XCTWaiter.fulfillment(of: [failed], timeout: 1)
        // Disconnect releases the held cleanup request, including on failure.
        await client.disconnect()
        await preparation.value
        XCTAssertEqual(result, .completed)
    }

    func testGenericFileUsesTypedUploadAndRawPostBody() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileURL = directory.appendingPathComponent("notes.txt")
        let fileData = Data("review notes".utf8)
        try fileData.write(to: fileURL)
        let descriptor = try attachmentDescriptor(
            #"{"attachmentUploads":true,"fileAttachments":{"maxUploadBytes":52428800}}"#
        )
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!,
            descriptor: descriptor
        )
        let transport = RecordingHTTPTransport { request in
            if request.url?.path == "/api/auth/websocket-ticket" {
                return (
                    Data(#"{"ticket":"websocket-ticket","expiresAt":"2026-07-30T12:05:00.000Z"}"#.utf8),
                    transportResponse(request)
                )
            }
            return (Data(), transportResponse(request, status: 204))
        }
        let connection = RecordingWebSocketConnection()
        let client = T3Client(
            environment: environment,
            credentialStore: InMemoryCredentialStore(credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]),
            httpTransport: transport,
            webSocketConnector: StaticWebSocketConnector(connection: connection)
        )
        let file = try UploadChatAttachment(
            fileURL: fileURL,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: fileData.count
        )

        _ = try await client.createThreadAndSend(
            threadID: "thread-file",
            projectID: "project-1",
            title: "File task",
            text: "Review this file",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            attachments: [file]
        )
        await client.disconnect()

        let socketRequests = await connection.requests()
        XCTAssertEqual(socketRequests[0]["payload"]?["type"]?.stringValue, "file")
        guard case let .array(sent)? = socketRequests[1]["payload"]?["message"]?["attachments"] else {
            return XCTFail("Expected an uploaded file reference")
        }
        XCTAssertEqual(sent.first?["type"]?.stringValue, "file")
        XCTAssertEqual(sent.first?["mimeType"]?.stringValue, "text/plain")
        XCTAssertNil(sent.first?["dataUrl"])

        let requests = await transport.requests
        let upload = try XCTUnwrap(requests.last)
        XCTAssertEqual(upload.httpMethod, "POST")
        XCTAssertEqual(upload.httpBody, fileData)
        XCTAssertEqual(upload.value(forHTTPHeaderField: "Content-Type"), "text/plain")
    }

    func testGenericFileRejectsAnOlderServerBeforeDispatch() async throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("unsupported-\(UUID().uuidString).txt")
        defer { try? FileManager.default.removeItem(at: fileURL) }
        try Data("file".utf8).write(to: fileURL)
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let connection = RecordingWebSocketConnection()
        let client = T3Client(
            environment: environment,
            credentialStore: InMemoryCredentialStore(),
            webSocketConnector: StaticWebSocketConnector(connection: connection)
        )
        let file = try UploadChatAttachment(
            fileURL: fileURL,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 4
        )

        do {
            _ = try await client.sendTurn(
                threadID: "thread-1",
                text: "Review",
                runtimeMode: .fullAccess,
                attachments: [file]
            )
            XCTFail("Expected unsupported file rejection")
        } catch FileAttachmentError.unsupported {
            let requests = await connection.requests()
            XCTAssertTrue(requests.isEmpty)
        }
    }

    func testGenericFileUsesTheAdvertisedByteLimit() async throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("large-\(UUID().uuidString).txt")
        defer { try? FileManager.default.removeItem(at: fileURL) }
        try Data("four".utf8).write(to: fileURL)
        let descriptor = try attachmentDescriptor(
            #"{"attachmentUploads":true,"fileAttachments":{"maxUploadBytes":3}}"#
        )
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!,
            descriptor: descriptor
        )
        let client = T3Client(
            environment: environment,
            credentialStore: InMemoryCredentialStore()
        )
        let file = try UploadChatAttachment(
            fileURL: fileURL,
            name: "large.txt",
            mimeType: "text/plain",
            sizeBytes: 4
        )

        do {
            _ = try await client.sendTurn(
                threadID: "thread-1",
                text: "Review",
                runtimeMode: .fullAccess,
                attachments: [file]
            )
            XCTFail("Expected the advertised limit to reject the file")
        } catch let FileAttachmentError.tooLarge(actualBytes, maximumBytes) {
            XCTAssertEqual(actualBytes, 4)
            XCTAssertEqual(maximumBytes, 3)
        }
    }

    func testFeedbackRPCUsesTheThreadAndOptionalReason() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: EnvironmentCredential(accessToken: "access-token"),
        ])
        let transport = RecordingHTTPTransport { request in
            (
                Data(#"{"ticket":"websocket-ticket","expiresAt":"2026-07-30T12:05:00.000Z"}"#.utf8),
                transportResponse(request)
            )
        }
        let connection = RecordingWebSocketConnection()
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: StaticWebSocketConnector(connection: connection)
        )

        let withReason = try await client.uploadFeedback(
            threadID: "thread-1",
            reason: "The agent stopped early."
        )
        let withoutReason = try await client.uploadFeedback(threadID: "thread-2")
        await client.disconnect()

        XCTAssertEqual(withReason.feedbackId, "codex-thread-1")
        XCTAssertEqual(withoutReason.feedbackId, "codex-thread-1")
        let requests = await connection.requests()
        XCTAssertEqual(requests.map { $0["tag"]?.stringValue }, [
            "provider.uploadFeedback",
            "provider.uploadFeedback",
        ])
        XCTAssertEqual(requests[0]["payload"]?["threadId"]?.stringValue, "thread-1")
        XCTAssertEqual(requests[0]["payload"]?["reason"]?.stringValue, "The agent stopped early.")
        XCTAssertEqual(requests[1]["payload"]?["threadId"]?.stringValue, "thread-2")
        XCTAssertNil(requests[1]["payload"]?["reason"])
    }

    func testUnsentCommandsFallBackToHTTPButBootstrapDoesNot() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]
        )
        let transport = RecordingHTTPTransport { request in
            let body = if request.url?.path == "/api/auth/websocket-ticket" {
                """
                {
                  "ticket": "websocket-ticket",
                  "expiresAt": "2026-07-30T12:05:00.000Z"
                }
                """
            } else {
                """
                {"sequence": 9}
                """
            }
            return (Data(body.utf8), transportResponse(request))
        }
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: FailingWebSocketConnector(),
            rpcConnectionWaitTimeout: .milliseconds(30)
        )

        let rename = try await client.rename(threadID: "thread-1", title: "Renamed")
        XCTAssertEqual(rename.sequence, 9)

        do {
            _ = try await client.createThreadAndSend(
                threadID: "thread-first-send",
                projectID: "project-1",
                title: "Native first send",
                text: "Start from this message",
                model: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
                runtimeMode: .fullAccess
            )
            XCTFail("Bootstrap must not use the HTTP endpoint that cannot expand it.")
        } catch let error as RPCError {
            guard case .connectionUnavailable = error else {
                return XCTFail("Unexpected RPC error: \(error)")
            }
        }
        await client.disconnect()

        let requests = await transport.requests
        let dispatchRequests = requests.filter {
            $0.url?.path == "/api/orchestration/dispatch"
        }
        XCTAssertEqual(dispatchRequests.count, 1)
        let command = try JSONDecoder.t3.decode(
            JSONValue.self,
            from: try XCTUnwrap(dispatchRequests.first?.httpBody)
        )
        XCTAssertEqual(command["type"]?.stringValue, "thread.meta.update")
    }

    /// Set `T3_SWIFT_WS_DEFLATE_ECHO_URL` to a WebSocket endpoint that rejects
    /// non-deflate handshakes and echoes binary frames. This is intentionally
    /// opt-in because XCTest does not own a Node process. A successful round
    /// trip proves URLSession accepted the server's compressed frame.
    func testLivePerMessageDeflateRoundTripWhenConfigured() async throws {
        guard let value = ProcessInfo.processInfo.environment[
            "T3_SWIFT_WS_DEFLATE_ECHO_URL"
        ], let url = URL(string: value) else {
            throw XCTSkip("Set T3_SWIFT_WS_DEFLATE_ECHO_URL for live compression proof.")
        }
        let connection = try await URLSessionWebSocketConnector().connect(to: url)
        defer { Task { await connection.close() } }
        let payload = Data(repeating: 0x54, count: 64 * 1024)
        try await connection.send(payload)
        let echoed = try await connection.receive()
        XCTAssertEqual(echoed, payload)
    }

    func testPairingInputParsesClipboardQRHostedAndLooseFormats() throws {
        let direct = try PairingURL.parseFields(
            " https://studio.example:3773/pair#token=N735%4BQXJ "
        )
        XCTAssertEqual(direct.host, "https://studio.example:3773")
        XCTAssertEqual(direct.pairingCode, "N735KQXJ")

        let hosted = try PairingURL.parseFields(
            "https://app.t3.codes/pair?host=http%3A%2F%2F192.168.1.7%3A18773"
                + "&label=Big%20O#token=PAIRING"
        )
        XCTAssertEqual(hosted.host, "http://192.168.1.7:18773")
        XCTAssertEqual(hosted.pairingCode, "PAIRING")
        XCTAssertEqual(hosted.label, "Big O")

        let loose = try PairingURL.parseFields("192.168.1.7:18773 N735KQXJ5SJW")
        XCTAssertEqual(loose.host, "https://192.168.1.7:18773")
        XCTAssertEqual(loose.pairingCode, "N735KQXJ5SJW")

        let wrapped = try PairingURL.pairingURL(
            fromQRCode: "t3code://pair?pairingUrl=https%3A%2F%2Fstudio.example"
                + "%2Fpair%23token%3DQR-CODE"
        )
        XCTAssertEqual(wrapped, "https://studio.example/pair#token=QR-CODE")
        XCTAssertEqual(try PairingURL.parseFields(wrapped).pairingCode, "QR-CODE")
    }

    func testSplitPairingFieldsAcceptCompleteURLInHostField() throws {
        let target = try PairingURL.resolve(
            host: "http://192.168.1.7:18773/pair#token=FROM-URL",
            pairingCode: ""
        )
        XCTAssertEqual(target.credential, "FROM-URL")
        XCTAssertEqual(target.httpBaseURL.absoluteString, "http://192.168.1.7:18773/")
        XCTAssertEqual(target.webSocketBaseURL.absoluteString, "ws://192.168.1.7:18773/")
    }

    func testLocalNetworkProbeClassificationDistinguishesFailureModes() {
        XCTAssertTrue(LocalNetworkProbe.isLocalHost("192.168.20.4"))
        XCTAssertTrue(LocalNetworkProbe.isLocalHost("studio.local"))
        XCTAssertFalse(LocalNetworkProbe.isLocalHost("app.t3.codes"))

        let denied = NSError(
            domain: NSURLErrorDomain,
            code: URLError.notConnectedToInternet.rawValue,
            userInfo: [
                NSUnderlyingErrorKey: NSError(
                    domain: NSPOSIXErrorDomain,
                    code: 13
                ),
            ]
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(denied, host: "192.168.20.4", isLocal: true),
            .likelyLocalNetworkDenied("192.168.20.4")
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(
                URLError(.timedOut),
                host: "studio.local",
                isLocal: true
            ),
            .timeout("studio.local")
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(
                URLError(.cannotConnectToHost),
                host: "studio.local",
                isLocal: true
            ),
            .unavailableHost("studio.local")
        )
    }

    func testLocalNetworkProbeAcceptsWebSocketPairingSchemes() async throws {
        let transport = RecordingHTTPTransport { request in
            let body = """
            {
              "environmentId": "environment-1",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": {}
            }
            """
            return (Data(body.utf8), transportResponse(request))
        }
        let result = try await LocalNetworkProbe(transport: transport).probe(
            address: "wss://studio.example"
        )

        XCTAssertEqual(result.baseURL.absoluteString, "https://studio.example/")
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.url?.scheme, "https")
        XCTAssertEqual(request.url?.path, "/.well-known/t3/environment")
    }

}

private func paginationThreadFixture() -> OrchestrationThread {
    OrchestrationThread(
        id: "thread-1",
        projectId: "project-1",
        title: "Long native thread",
        modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
        runtimeMode: .fullAccess,
        interactionMode: .default,
        branch: "main",
        worktreePath: nil,
        latestTurn: nil,
        createdAt: "2026-08-06T12:00:00.000Z",
        updatedAt: "2026-08-06T12:00:00.000Z",
        archivedAt: nil,
        settledOverride: nil,
        settledAt: nil,
        snoozedUntil: nil,
        snoozedAt: nil,
        pinnedAt: nil,
        deletedAt: nil,
        messages: [],
        activities: [],
        checkpoints: [],
        session: nil
    )
}

private func transportResponse(
    _ request: URLRequest,
    status: Int = 200,
    headers: [String: String] = ["Content-Type": "application/json"]
) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: headers
    )!
}

private actor RecordingHTTPTransport: HTTPTransport {
    typealias Handler = @Sendable (URLRequest) throws -> (Data, HTTPURLResponse)

    private(set) var requests: [URLRequest] = []
    private let handler: Handler

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        return try handler(request)
    }
}

private func attachmentDescriptor(_ capabilities: String) throws -> EnvironmentDescriptor {
    try JSONDecoder.t3.decode(
        EnvironmentDescriptor.self,
        from: Data(
            """
            {
              "environmentId": "environment-1",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": \(capabilities)
            }
            """.utf8
        )
    )
}

private struct StaticWebSocketConnector: WebSocketConnecting {
    let connection: RecordingWebSocketConnection

    func connect(to url: URL) async throws -> any WebSocketConnection {
        await connection.recordConnectionURL(url)
        return connection
    }
}

private struct FailingWebSocketConnector: WebSocketConnecting {
    func connect(to _: URL) async throws -> any WebSocketConnection {
        throw URLError(.cannotConnectToHost)
    }
}

private actor RecordingWebSocketConnection: WebSocketConnection {
    private let assetErrorMessage: String?
    private let holdAttachmentDeletion: Bool
    private var attachmentDeletionStarted = false
    private var attachmentDeletionWaiter: CheckedContinuation<Void, Never>?
    private var recordedRequests: [JSONValue] = []
    private var recordedConnectionURLs: [URL] = []
    private var queuedResponses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?

    init(assetErrorMessage: String? = nil, holdAttachmentDeletion: Bool = false) {
        self.assetErrorMessage = assetErrorMessage
        self.holdAttachmentDeletion = holdAttachmentDeletion
    }

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        recordedRequests.append(request)
        guard case let .number(rawID) = request["id"] else { return }
        if request["tag"]?.stringValue == "attachments.delete", holdAttachmentDeletion {
            attachmentDeletionStarted = true
            attachmentDeletionWaiter?.resume()
            attachmentDeletionWaiter = nil
            return
        }
        if request["tag"]?.stringValue == "assets.createUrl", let assetErrorMessage {
            let response = JSONValue.object([
                "_tag": .string("Exit"),
                "requestId": .number(rawID),
                "exit": .object([
                    "_tag": .string("Failure"),
                    "cause": .array([.object([
                        "_tag": .string("Fail"),
                        "error": .object(["message": .string(assetErrorMessage)]),
                    ])]),
                ]),
            ])
            enqueue(try JSONEncoder.t3.encode(response))
            return
        }
        let value: JSONValue
        switch request["tag"]?.stringValue {
        case "attachments.createUploadUrl":
            value = .object([
                "attachmentId": .string("uploaded-attachment-1"),
                "relativeUrl": .string("/api/attachments/upload/signed-token"),
                "expiresAt": .number(1_785_466_800_000),
            ])
        case "provider.uploadFeedback":
            value = .object(["feedbackId": .string("codex-thread-1")])
        case "assets.createUrl":
            value = .object([
                "relativeUrl": .string("/api/assets/attachment"),
                "expiresAt": .number(1_785_466_800_000),
            ])
        default:
            value = .object(["sequence": .number(42)])
        }
        let response = JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(rawID),
            "exit": .object([
                "_tag": .string("Success"),
                "value": value,
            ]),
        ])
        enqueue(try JSONEncoder.t3.encode(response))
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    func requests() -> [JSONValue] {
        recordedRequests
    }

    func waitForAttachmentDeletion() async {
        guard !attachmentDeletionStarted else { return }
        await withCheckedContinuation { attachmentDeletionWaiter = $0 }
    }

    func recordConnectionURL(_ url: URL) {
        recordedConnectionURLs.append(url)
    }

    func connectionURLs() -> [URL] {
        recordedConnectionURLs
    }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }
}
