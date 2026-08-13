import Foundation

enum MarkdownOpenURLDisposition: Equatable {
    case handled
    case discarded
    case systemAction

    static func resolve(
        url: URL,
        onOpenURL: ((URL) -> Bool)?
    ) -> Self {
        if onOpenURL?(url) == true {
            return .handled
        }
        if url.scheme?.caseInsensitiveCompare("file") == .orderedSame {
            return .discarded
        }
        return .systemAction
    }
}
