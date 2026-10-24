import Foundation

enum WorkflowScript {
    static func isScript(_ text: String, explicit: Bool?) -> Bool {
        if let explicit { return explicit }
        return text.range(of: #"^\s*(?:(?://[^\n]*(?:\n|$)|/\*[\s\S]*?\*/)\s*)*export\s+const\s+meta\b"#,
                          options: .regularExpression) != nil
    }
}
