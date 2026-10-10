import AuthenticationServices
import ExpoModulesCore
import UIKit

/// Answers a server browser page's WebAuthn request with the system passkey
/// sheet, for the page's own origin. AuthenticationServices serves any site only
/// to apps that hold Apple's browser entitlement, so builds without it report
/// unavailable and are never asked.
public final class T3PasskeysModule: Module {
  private var ceremony: T3PasskeyCeremony?

  public func definition() -> ModuleDefinition {
    Name("T3Passkeys")

    Constants {
      // app.config.ts sets this only in builds signed with the entitlement.
      ["available": Bundle.main.object(forInfoDictionaryKey: "T3BrowserPasskeys") as? Bool == true]
    }

    // Both run on the main queue, where AuthenticationServices presents its sheet.
    AsyncFunction("perform") { (id: String, kind: String, origin: String, options: String, promise: Promise) in
      MainActor.assumeIsolated {
        // One sheet at a time: a newer request replaces one still unanswered.
        self.ceremony?.cancel()
        // The ceremony drops this completion once it runs, which ends the cycle back to the module.
        let ceremony = T3PasskeyCeremony(id: id, kind: kind, origin: origin, options: options) { result in
          if self.ceremony?.id == id { self.ceremony = nil }
          promise.resolve(result)
        }
        self.ceremony = ceremony
        ceremony.start()
      }
    }.runOnQueue(.main)

    AsyncFunction("cancel") { (id: String) in
      MainActor.assumeIsolated {
        if self.ceremony?.id == id { self.ceremony?.cancel() }
      }
    }.runOnQueue(.main)

    OnDestroy {
      let ceremony = self.ceremony
      DispatchQueue.main.async { ceremony?.cancel() }
    }
  }
}

/// One WebAuthn ceremony. The server has checked the origin and RP ID; the
/// result goes back as a `PreviewStreamPasskeyResult` in JSON.
final class T3PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  let id: String
  private let kind: String
  private let origin: String
  private let options: String
  private var completion: ((String) -> Void)?
  private var controller: ASAuthorizationController?

  private static let notAllowed: [String: Any] = ["success": false, "error": "NotAllowedError"]
  private static let transports: [String: ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor.Transport] = [
    "usb": .usb, "nfc": .nfc, "ble": .bluetooth,
  ]

  init(id: String, kind: String, origin: String, options: String, completion: @escaping (String) -> Void) {
    self.id = id
    self.kind = kind
    self.origin = origin
    self.options = options
    self.completion = completion
  }

  func start() {
    guard let requests = makeRequests(), !requests.isEmpty else {
      finish(["success": false, "error": "TypeError"])
      return
    }
    let controller = ASAuthorizationController(authorizationRequests: requests)
    controller.delegate = self
    controller.presentationContextProvider = self
    self.controller = controller
    controller.performRequests()
  }

  func cancel() {
    controller?.cancel()
    finish(Self.notAllowed)
  }

  // Passkeys on the device and security keys are offered together, as Safari does,
  // unless the page asked for one kind of authenticator.
  private func makeRequests() -> [ASAuthorizationRequest]? {
    let json = Data(options.utf8)
    if kind == "create" {
      guard
        let options = try? JSONDecoder().decode(CreationOptions.self, from: json),
        let challenge = Data(base64URL: options.challenge),
        let userID = Data(base64URL: options.user.id)
      else { return nil }
      let clientData = ASPublicKeyCredentialClientData(challenge: challenge, origin: origin)
      let selection = options.authenticatorSelection
      let verification = ASAuthorizationPublicKeyCredentialUserVerificationPreference(
        rawValue: selection?.userVerification ?? "preferred")
      let attestation = ASAuthorizationPublicKeyCredentialAttestationKind(rawValue: options.attestation ?? "none")
      let excluded = (options.excludeCredentials ?? []).compactMap { descriptor in
        Data(base64URL: descriptor.id).map { (descriptor, $0) }
      }
      var requests: [ASAuthorizationRequest] = []
      if selection?.authenticatorAttachment != "cross-platform" {
        let request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rp.id)
          .createCredentialRegistrationRequest(clientData: clientData, name: options.user.name, userID: userID)
        request.displayName = options.user.displayName
        request.userVerificationPreference = verification
        request.attestationPreference = attestation
        request.excludedCredentials = excluded.map {
          ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0.1)
        }
        requests.append(request)
      }
      if selection?.authenticatorAttachment != "platform" {
        let request = ASAuthorizationSecurityKeyPublicKeyCredentialProvider(relyingPartyIdentifier: options.rp.id)
          .createCredentialRegistrationRequest(
            clientData: clientData,
            displayName: options.user.displayName ?? options.user.name,
            name: options.user.name,
            userID: userID
          )
        request.credentialParameters = [ASAuthorizationPublicKeyCredentialParameters(algorithm: .ES256)]
        request.excludedCredentials = excluded.map { securityKey($0.0, id: $0.1) }
        request.residentKeyPreference = ASAuthorizationPublicKeyCredentialResidentKeyPreference(
          rawValue: selection?.residentKey ?? (selection?.requireResidentKey == true ? "required" : "discouraged"))
        request.userVerificationPreference = verification
        request.attestationPreference = attestation
        requests.append(request)
      }
      return requests
    }
    guard
      let options = try? JSONDecoder().decode(RequestOptions.self, from: json),
      let challenge = Data(base64URL: options.challenge)
    else { return nil }
    let clientData = ASPublicKeyCredentialClientData(challenge: challenge, origin: origin)
    let verification = ASAuthorizationPublicKeyCredentialUserVerificationPreference(
      rawValue: options.userVerification ?? "preferred")
    let allowed = (options.allowCredentials ?? []).compactMap { descriptor in
      Data(base64URL: descriptor.id).map { (descriptor, $0) }
    }
    let platform = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rpId)
      .createCredentialAssertionRequest(clientData: clientData)
    platform.allowedCredentials = allowed.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0.1) }
    platform.userVerificationPreference = verification
    let key = ASAuthorizationSecurityKeyPublicKeyCredentialProvider(relyingPartyIdentifier: options.rpId)
      .createCredentialAssertionRequest(clientData: clientData)
    key.allowedCredentials = allowed.map { securityKey($0.0, id: $0.1) }
    key.userVerificationPreference = verification
    return [platform, key]
  }

  private func securityKey(_ descriptor: Descriptor, id: Data) -> ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor {
    let transports = (descriptor.transports ?? []).compactMap { Self.transports[$0] }
    return ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor(
      credentialID: id,
      transports: transports.isEmpty ? ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor.Transport.allSupported : transports
    )
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    switch authorization.credential {
    case let registration as ASAuthorizationPlatformPublicKeyCredentialRegistration:
      guard let attestation = registration.rawAttestationObject else { return finish(Self.notAllowed) }
      finish(succeeded([
        "id": registration.credentialID.base64URL,
        "clientDataJSON": registration.rawClientDataJSON.base64URL,
        "attestationObject": attestation.base64URL,
        "authenticatorAttachment": Self.attachment(registration.attachment),
        "transports": ["hybrid", "internal"],
      ]))
    case let registration as ASAuthorizationSecurityKeyPublicKeyCredentialRegistration:
      guard let attestation = registration.rawAttestationObject else { return finish(Self.notAllowed) }
      finish(succeeded([
        "id": registration.credentialID.base64URL,
        "clientDataJSON": registration.rawClientDataJSON.base64URL,
        "attestationObject": attestation.base64URL,
        "authenticatorAttachment": "cross-platform",
        "transports": registration.transports.map(\.rawValue),
      ]))
    case let assertion as ASAuthorizationPlatformPublicKeyCredentialAssertion:
      finish(succeeded([
        "id": assertion.credentialID.base64URL,
        "clientDataJSON": assertion.rawClientDataJSON.base64URL,
        "authenticatorData": assertion.rawAuthenticatorData.base64URL,
        "signature": assertion.signature.base64URL,
        "userHandle": assertion.userID.base64URL,
        "authenticatorAttachment": Self.attachment(assertion.attachment),
      ]))
    case let assertion as ASAuthorizationSecurityKeyPublicKeyCredentialAssertion:
      finish(succeeded([
        "id": assertion.credentialID.base64URL,
        "clientDataJSON": assertion.rawClientDataJSON.base64URL,
        "authenticatorData": assertion.rawAuthenticatorData.base64URL,
        "signature": assertion.signature.base64URL,
        "userHandle": assertion.userID.base64URL,
        "authenticatorAttachment": "cross-platform",
      ]))
    default:
      finish(Self.notAllowed)
    }
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    // WebAuthn reports a passkey this site already has as InvalidStateError; anything else stays opaque.
    let excluded = (error as? ASAuthorizationError)?.code == .matchedExcludedCredential
    finish(excluded ? ["success": false, "error": "InvalidStateError"] : Self.notAllowed)
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
  }

  private func succeeded(_ credential: [String: Any]) -> [String: Any] {
    ["success": true, "credential": credential]
  }

  private static func attachment(_ attachment: ASAuthorizationPublicKeyCredentialAttachment) -> String {
    attachment == .crossPlatform ? "cross-platform" : "platform"
  }

  private func finish(_ result: [String: Any]) {
    guard let completion else { return }
    self.completion = nil
    controller = nil
    let data = (try? JSONSerialization.data(withJSONObject: result))
      ?? Data(#"{"success":false,"error":"NotAllowedError"}"#.utf8)
    completion(String(decoding: data, as: UTF8.self))
  }
}

private struct Descriptor: Decodable {
  let id: String
  let transports: [String]?
}

/// The members of `PublicKeyCredentialCreationOptionsJSON` the system sheet uses.
private struct CreationOptions: Decodable {
  struct RelyingParty: Decodable {
    let id: String
  }

  struct User: Decodable {
    let id: String
    let name: String
    let displayName: String?
  }

  struct Selection: Decodable {
    let authenticatorAttachment: String?
    let residentKey: String?
    let requireResidentKey: Bool?
    let userVerification: String?
  }

  let rp: RelyingParty
  let user: User
  let challenge: String
  let excludeCredentials: [Descriptor]?
  let authenticatorSelection: Selection?
  let attestation: String?
}

/// The members of `PublicKeyCredentialRequestOptionsJSON` the system sheet uses.
private struct RequestOptions: Decodable {
  let rpId: String
  let challenge: String
  let allowCredentials: [Descriptor]?
  let userVerification: String?
}

private extension Data {
  init?(base64URL: String) {
    var base64 = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    self.init(base64Encoded: base64)
  }

  var base64URL: String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
