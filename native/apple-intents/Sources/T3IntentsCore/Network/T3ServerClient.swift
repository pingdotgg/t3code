import CryptoKit
import Foundation

public struct T3LaunchThreadResponse: Codable, Sendable {
  public let threadId: String
  public let projectId: String
  public let title: String
  public let resumed: Bool
  public let sequence: Int?

  public init(threadId: String, projectId: String, title: String, resumed: Bool, sequence: Int?) {
    self.threadId = threadId
    self.projectId = projectId
    self.title = title
    self.resumed = resumed
    self.sequence = sequence
  }
}

public struct T3SendMessageResponse: Codable, Sendable {
  public let threadId: String
  public let messageId: String
  public let runId: String?
  public let delivery: String

  public init(threadId: String, messageId: String, runId: String?, delivery: String) {
    self.threadId = threadId
    self.messageId = messageId
    self.runId = runId
    self.delivery = delivery
  }
}

public struct T3DispatchCommandResponse: Codable, Sendable {
  public let sequence: Int

  public init(sequence: Int) {
    self.sequence = sequence
  }
}

public protocol T3EnvironmentOperating: Sendable {
  func launchThread(
    environmentId: String,
    projectId: String,
    title: String?,
    message: String?,
    interactionMode: String
  ) async throws -> T3LaunchThreadResponse

  func sendMessage(
    environmentId: String,
    threadId: String,
    text: String,
    mode: String
  ) async throws -> T3SendMessageResponse

  func dispatchCommand(
    environmentId: String,
    payload: [String: AnySendable]
  ) async throws -> T3DispatchCommandResponse
}

public enum AnySendable: Sendable, Encodable {
  case string(String)
  case bool(Bool)
  case int(Int)
  case null

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let v): try container.encode(v)
    case .bool(let v): try container.encode(v)
    case .int(let v): try container.encode(v)
    case .null: try container.encodeNil()
    }
  }
}

/// Authenticated HTTP client supporting Bearer and ES256 DPoP proofs (RFC 9449) against
/// any T3 Code server reachable over localhost, LAN, Tailscale, or T3 Connect.
public final class T3ServerClient: T3EnvironmentOperating, @unchecked Sendable {
  public static let shared = T3ServerClient(credentials: T3KeychainCredentialStore.shared)

  private let credentials: any T3CredentialProviding
  private let session: URLSession
  private let creationSource: String

  public init(
    credentials: any T3CredentialProviding,
    session: URLSession? = nil
  ) {
    self.credentials = credentials
    if let session {
      self.session = session
    } else {
      let config = URLSessionConfiguration.ephemeral
      config.timeoutIntervalForRequest = 20
      config.timeoutIntervalForResource = 30
      self.session = URLSession(configuration: config)
    }
    #if os(iOS)
    self.creationSource = "mobile"
    #else
    self.creationSource = "web"
    #endif
  }

  public func launchThread(
    environmentId: String,
    projectId: String,
    title: String?,
    message: String?,
    interactionMode: String
  ) async throws -> T3LaunchThreadResponse {
    var body: [String: AnySendable] = [
      "commandId": .string(UUID().uuidString),
      "projectId": .string(projectId),
      "interactionMode": .string(interactionMode),
      "creationSource": .string(creationSource),
    ]
    if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      body["title"] = .string(title.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    if let message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      body["message"] = .string(message)
    }
    return try await post(environmentId: environmentId, path: "/api/orchestration/threads", body: body)
  }

  public func sendMessage(
    environmentId: String,
    threadId: String,
    text: String,
    mode: String
  ) async throws -> T3SendMessageResponse {
    let encodedThreadId = threadId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? threadId
    let body: [String: AnySendable] = [
      "commandId": .string(UUID().uuidString),
      "messageId": .string(UUID().uuidString),
      "text": .string(text),
      "mode": .string(mode),
      "creationSource": .string(creationSource),
    ]
    return try await post(
      environmentId: environmentId,
      path: "/api/orchestration/threads/\(encodedThreadId)/messages",
      body: body
    )
  }

  public func dispatchCommand(
    environmentId: String,
    payload: [String: AnySendable]
  ) async throws -> T3DispatchCommandResponse {
    try await post(environmentId: environmentId, path: "/api/orchestration/commands", body: payload)
  }

  private func post<Response: Decodable>(
    environmentId: String,
    path: String,
    body: [String: AnySendable]
  ) async throws -> Response {
    guard let cred = credentials.credential(for: environmentId) else {
      throw T3IntentError.environmentNotAuthenticated
    }
    let normalizedBase = cred.httpBaseUrl.hasSuffix("/")
      ? String(cred.httpBaseUrl.dropLast())
      : cred.httpBaseUrl
    guard let url = URL(string: normalizedBase + path) else {
      throw T3IntentError.environmentUnreachable
    }
    // A saved address can be reassigned to another host; never hand it this environment's token.
    if cred.relayManaged != true {
      try await verifyEnvironment(baseUrl: normalizedBase, expectedEnvironmentId: environmentId)
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(
      T3IntentsConfig.orchestrationProtocolVersion,
      forHTTPHeaderField: T3IntentsConfig.orchestrationProtocolHeader
    )

    if cred.authScheme == "DPoP",
       let proof = try? buildDpopProof(
         method: "POST",
         url: url,
         accessToken: cred.accessToken,
         privateKeyBase64: cred.dpopKeyRef
       ) {
      request.setValue("DPoP \(cred.accessToken)", forHTTPHeaderField: "Authorization")
      request.setValue(proof, forHTTPHeaderField: "DPoP")
    } else {
      request.setValue("Bearer \(cred.accessToken)", forHTTPHeaderField: "Authorization")
    }

    request.httpBody = try JSONEncoder().encode(body)

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw T3IntentError.environmentUnreachable
    }

    guard let http = response as? HTTPURLResponse else {
      throw T3IntentError.environmentUnreachable
    }
    return try decodeResponse(data: data, statusCode: http.statusCode)
  }

  private struct EnvironmentDescriptor: Decodable {
    let environmentId: String
  }

  /// Reads the unauthenticated descriptor, as the app does before authorizing a direct route.
  private func verifyEnvironment(baseUrl: String, expectedEnvironmentId: String) async throws {
    guard let url = URL(string: baseUrl + "/.well-known/t3/environment") else {
      throw T3IntentError.environmentUnreachable
    }
    var request = URLRequest(url: url)
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw T3IntentError.environmentUnreachable
    }
    guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
          let descriptor = try? JSONDecoder().decode(EnvironmentDescriptor.self, from: data)
    else {
      throw T3IntentError.environmentUnreachable
    }
    guard descriptor.environmentId == expectedEnvironmentId else {
      throw T3IntentError.environmentMismatch
    }
  }

  private func decodeResponse<Response: Decodable>(
    data: Data,
    statusCode: Int
  ) throws -> Response {
    switch statusCode {
    case 200...299:
      do {
        return try JSONDecoder().decode(Response.self, from: data)
      } catch {
        throw T3IntentError.serverRejected("Unexpected response from T3 Code server.")
      }
    case 401:
      throw T3IntentError.environmentNotAuthenticated
    case 403:
      throw T3IntentError.permissionDenied
    case 404:
      throw T3IntentError.resourceNotFound
    default:
      throw T3IntentError.serverRejected("Server returned HTTP \(statusCode).")
    }
  }

  /// Signs an RFC 9449 ES256 DPoP proof JWT using a 32-byte raw P-256 scalar (base64 or base64url).
  internal func buildDpopProof(
    method: String,
    url: URL,
    accessToken: String,
    privateKeyBase64: String?
  ) throws -> String? {
    guard let privateKeyBase64, !privateKeyBase64.isEmpty,
          let rawKey = Data(base64Encoded: privateKeyBase64) ?? Data(base64UrlEncoded: privateKeyBase64)
    else {
      return nil
    }
    let scalar = rawKey.count >= 32 ? rawKey.prefix(32) : rawKey
    let signingKey = try P256.Signing.PrivateKey(rawRepresentation: scalar)
    let x963 = signingKey.publicKey.x963Representation
    // Uncompressed P-256 point: 0x04 || x (32 bytes) || y (32 bytes).
    guard x963.count == 65, x963[0] == 0x04 else { return nil }
    let xCoord = x963[1..<33].base64UrlEncodedString()
    let yCoord = x963[33..<65].base64UrlEncodedString()

    let header: [String: Any] = [
      "typ": "dpop+jwt",
      "alg": "ES256",
      "jwk": [
        "kty": "EC",
        "crv": "P-256",
        "x": xCoord,
        "y": yCoord,
      ],
    ]
    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    components?.query = nil
    components?.fragment = nil
    let htu = components?.string ?? url.absoluteString
    let ath = Data(SHA256.hash(data: Data(accessToken.utf8))).base64UrlEncodedString()
    let claims: [String: Any] = [
      "jti": UUID().uuidString,
      "htm": method.uppercased(),
      "htu": htu,
      "iat": Int(Date().timeIntervalSince1970),
      "ath": ath,
    ]
    let headerData = try JSONSerialization.data(withJSONObject: header)
    let claimsData = try JSONSerialization.data(withJSONObject: claims)
    let signingInput = "\(headerData.base64UrlEncodedString()).\(claimsData.base64UrlEncodedString())"
    let signature = try signingKey.signature(for: Data(signingInput.utf8)).rawRepresentation
    return "\(signingInput).\(signature.base64UrlEncodedString())"
  }
}

private extension Data {
  func base64UrlEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  init?(base64UrlEncoded string: String) {
    var base64 = string
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let padding = 4 - (base64.count % 4)
    if padding < 4 {
      base64 += String(repeating: "=", count: padding)
    }
    self.init(base64Encoded: base64)
  }
}
