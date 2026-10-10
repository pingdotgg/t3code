import Foundation
@testable import T3Code

/// Omits the protocol key so legacy fixtures exercise the V1 default.
func legacyEnvironmentDescriptorData(for environment: Environment) throws -> Data {
    let capabilities: JSONValue
    if let descriptor = environment.descriptor {
        capabilities = try .encode(descriptor.capabilities)
    } else {
        capabilities = .object(["repositoryIdentity": .bool(false)])
    }
    return try JSONEncoder.t3.encode(JSONValue.object([
        "environmentId": .string(environment.id),
        "label": .string(environment.label),
        "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
        "serverVersion": .string("1.0.0"),
        "capabilities": capabilities,
    ]))
}
