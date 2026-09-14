import SwiftUI

enum ProjectIconPresentation {
    static func symbol(_ name: String?) -> String {
        switch name {
        case "code", "code-xml", "code-2": "chevron.left.forwardslash.chevron.right"
        case "terminal", "square-terminal": "terminal"
        case "globe": "globe"
        case "smartphone": "iphone"
        case "monitor": "desktopcomputer"
        case "server": "server.rack"
        case "database": "externaldrive"
        case "cloud": "cloud"
        case "rocket": "paperplane"
        case "box", "package": "shippingbox"
        case "bug": "ladybug"
        case "book", "book-open": "book"
        case "heart": "heart"
        case "star": "star"
        case "zap": "bolt"
        case "music": "music.note"
        case "image": "photo"
        case "gamepad", "gamepad-2": "gamecontroller"
        case "cpu": "cpu"
        case "wrench": "wrench"
        case "git-branch": "arrow.triangle.branch"
        default: "folder"
        }
    }

    static func color(_ name: String?) -> Color {
        switch name {
        case "red", "rose": .red
        case "orange", "amber": .orange
        case "yellow": .yellow
        case "lime", "green", "emerald": .green
        case "teal": .teal
        case "cyan", "sky": .cyan
        case "blue": .blue
        case "indigo": .indigo
        case "violet", "purple": .purple
        case "fuchsia", "pink": .pink
        default: T3Colors.textSecondary
        }
    }
}
