import Foundation
import T3MobileProtocol

extension JSONValue {
    func requiredObject(_ label: String) throws -> [String: JSONValue] {
        guard let object = objectValue else {
            throw MobileSyncError.unexpectedMessage("Expected \(label) object.")
        }
        return object
    }
}

extension Dictionary where Key == String, Value == JSONValue {
    func requiredString(primaryKey: String, alternateKey: String) throws -> String {
        if let value = self[primaryKey]?.stringValue {
            return value
        }
        if let value = self[alternateKey]?.stringValue {
            return value
        }
        throw MobileSyncError.unexpectedMessage(
            "Expected \(primaryKey) or \(alternateKey) string."
        )
    }

    func requiredString(_ key: String) throws -> String {
        guard let value = self[key]?.stringValue else {
            throw MobileSyncError.unexpectedMessage("Expected \(key) string.")
        }
        return value
    }

    func optionalString(_ key: String) throws -> String? {
        guard let value = self[key] else {
            return nil
        }
        if case .null = value {
            return nil
        }
        guard let string = value.stringValue else {
            throw MobileSyncError.unexpectedMessage("Expected \(key) string or null.")
        }
        return string
    }

    func requiredInt(_ key: String) throws -> Int {
        guard let value = self[key]?.intValue else {
            throw MobileSyncError.unexpectedMessage("Expected \(key) integer.")
        }
        return value
    }

    func requiredBool(_ key: String) throws -> Bool {
        guard case let .bool(value) = self[key] else {
            throw MobileSyncError.unexpectedMessage("Expected \(key) boolean.")
        }
        return value
    }

    func requiredArray(_ key: String) throws -> [JSONValue] {
        guard let value = self[key]?.arrayValue else {
            throw MobileSyncError.unexpectedMessage("Expected \(key) array.")
        }
        return value
    }

    func optionalArray(_ key: String) throws -> [JSONValue] {
        guard let value = self[key] else {
            return []
        }
        if case .null = value {
            return []
        }
        guard let array = value.arrayValue else {
            throw MobileSyncError.unexpectedMessage("Expected \(key) array or null.")
        }
        return array
    }

    func optionalObject(_ key: String) throws -> [String: JSONValue]? {
        guard let value = self[key] else {
            return nil
        }
        if case .null = value {
            return nil
        }
        guard let object = value.objectValue else {
            throw MobileSyncError.unexpectedMessage("Expected \(key) object or null.")
        }
        return object
    }

    func requiredObject(_ key: String) throws -> [String: JSONValue] {
        guard let object = self[key]?.objectValue else {
            throw MobileSyncError.unexpectedMessage("Expected \(key) object.")
        }
        return object
    }
}
