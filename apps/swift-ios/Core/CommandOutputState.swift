import Foundation

struct CommandOutputStyle: Sendable, Equatable {
    enum Color: Sendable, Equatable { case indexed(Int), rgb(Int, Int, Int) }
    var foreground: Color?
    var background: Color?
    var bold = false
    var dim = false
    var italic = false
    var underline = false
    var strike = false
    var inverse = false

    mutating func apply(_ parameters: [Int]) {
        let parameters = parameters.isEmpty ? [0] : parameters
        var index = 0
        while index < parameters.count {
            let code = parameters[index]
            switch code {
            case 0: self = Self()
            case 1: bold = true
            case 2: dim = true
            case 3: italic = true
            case 4: underline = true
            case 7: inverse = true
            case 9: strike = true
            case 22: bold = false; dim = false
            case 23: italic = false
            case 24: underline = false
            case 27: inverse = false
            case 29: strike = false
            case 30...37: foreground = .indexed(code - 30)
            case 40...47: background = .indexed(code - 40)
            case 90...97: foreground = .indexed(code - 90 + 8)
            case 100...107: background = .indexed(code - 100 + 8)
            case 39: foreground = nil
            case 49: background = nil
            case 38, 48:
                var color: Color?
                if index + 2 < parameters.count, parameters[index + 1] == 5 {
                    color = .indexed(min(255, max(0, parameters[index + 2])))
                    index += 2
                } else if index + 4 < parameters.count, parameters[index + 1] == 2 {
                    color = .rgb(parameters[index + 2] & 255, parameters[index + 3] & 255, parameters[index + 4] & 255)
                    index += 4
                }
                if code == 38 { foreground = color } else { background = color }
            default: break
            }
            index += 1
        }
    }
}

/// Matches the shared terminal's 64-line cursor window and 64 KiB UTF-16 tail.
/// Replace frames rebuild cursor/style state; appends may finish a split escape.
struct CommandOutputState: Sendable, Equatable {
    struct Span: Sendable, Equatable {
        var text: String
        let style: CommandOutputStyle
    }
    private struct Cell: Sendable, Equatable {
        let unit: UInt16
        let style: Int
    }
    static let tailLimit = 64 * 1024
    private let limit: Int
    private var lines: [[Cell]] = [[]]
    private var settled: [Cell] = []
    private var row = 0
    private var column = 0
    private var saved: (row: Int, column: Int)?
    private var styles = [CommandOutputStyle()]
    private var styleIndex = 0
    private var pending: [UInt16] = []
    private(set) var truncated = false
    private(set) var running = true

    init(limit: Int = Self.tailLimit) { self.limit = max(1, limit) }

    // Tuple cursor storage has no synthesized Equatable conformance.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.limit == rhs.limit && lhs.lines == rhs.lines && lhs.settled == rhs.settled
            && lhs.row == rhs.row && lhs.column == rhs.column && lhs.saved?.row == rhs.saved?.row
            && lhs.saved?.column == rhs.saved?.column && lhs.styles == rhs.styles && lhs.styleIndex == rhs.styleIndex && lhs.pending == rhs.pending
            && lhs.truncated == rhs.truncated && lhs.running == rhs.running
    }

    var text: String { String(decoding: displayed.map(\.unit), as: UTF16.self) }
    var spans: [Span] {
        var spans: [Span] = []
        var units: [UInt16] = []
        var current = CommandOutputStyle()
        for cell in displayed {
            let style = spans.count < 1_999 ? styles[cell.style] : CommandOutputStyle()
            if style != current, !units.isEmpty {
                spans.append(Span(text: String(decoding: units, as: UTF16.self), style: current))
                units.removeAll(keepingCapacity: true)
            }
            current = style
            units.append(cell.unit)
        }
        if !units.isEmpty { spans.append(Span(text: String(decoding: units, as: UTF16.self), style: current)) }
        return spans
    }

    private var displayed: [Cell] {
        var cells = settled
        for (index, line) in lines.enumerated() {
            if index > 0 { cells.append(Cell(unit: 10, style: 0)) }
            cells.append(contentsOf: line)
        }
        return tail(cells)
    }

    mutating func apply(_ frame: CommandOutputFrame) {
        if frame.kind == .replace { self = Self(limit: limit) }
        truncated = truncated || frame.truncated
        running = frame.running
        feed(frame.text)
    }

    private mutating func feed(_ text: String) {
        let input = pending + Array(text.utf16)
        pending = []
        var index = 0
        while index < input.count {
            let unit = input[index]
            if unit == 27 {
                guard let end = escapeEnd(input, at: index) else {
                    let fragment = Array(input[index...])
                    if fragment.count <= 64 { pending = fragment }
                    else if fragment.count > 1, [93, 80, 88, 95, 94].contains(fragment[1]) {
                        pending = [27, fragment[1]] + (fragment.last == 27 ? [27] : [])
                    }
                    break
                }
                escape(Array(input[index..<end]))
                index = end
                continue
            }
            switch unit {
            case 10:
                row += 1; column = 0
                if row == lines.count { lines.append([]) }
                while lines.count > 64 { scrollOut() }
            case 13: column = 0
            case 8: column = max(0, column - 1)
            case 9, 32...126, 160...UInt16.max:
                let start = index
                while index < input.count {
                    let next = input[index]
                    guard next == 9 || (next >= 32 && next != 127 && !(128...159).contains(next)) else { break }
                    index += 1
                }
                write(input[start..<index])
                continue
            default: break
            }
            index += 1
        }
        boundWindow()
    }

    private mutating func write(_ units: ArraySlice<UInt16>) {
        if column > lines[row].count {
            lines[row].append(contentsOf: repeatElement(Cell(unit: 32, style: 0), count: column - lines[row].count))
        }
        let end = min(lines[row].count, column + units.count)
        lines[row].replaceSubrange(column..<end, with: units.map { Cell(unit: $0, style: styleIndex) })
        column += units.count
        if lines[row].count > limit {
            var removed = lines[row].count - limit
            if (0xDC00...0xDFFF).contains(lines[row][removed].unit) { removed += 1 }
            lines[row].removeFirst(removed)
            column = max(0, column - removed)
            if let saved, saved.row == row {
                self.saved = (saved.row, max(0, saved.column - removed))
            }
            truncated = true
        }
    }

    private mutating func scrollOut() {
        settled.append(contentsOf: lines.removeFirst())
        settled.append(Cell(unit: 10, style: 0))
        row -= 1
        if let saved { self.saved = (max(0, saved.row - 1), saved.column) }
        if settled.count > limit * 2 { settled = tail(settled); truncated = true }
    }

    private mutating func boundWindow() {
        var count = lines.reduce(0) { $0 + $1.count }
        while count > limit, row > 0 { count -= lines[0].count; scrollOut() }
        if count > limit {
            var budget = limit - lines.prefix(row + 1).reduce(0) { $0 + $1.count }
            if row + 1 < lines.count {
                for index in (row + 1)..<lines.count {
                    let keep = max(0, min(lines[index].count, budget))
                    let removed = lines[index].count - keep
                    if removed > 0 {
                        lines[index] = Array(lines[index].suffix(keep))
                        if let saved, saved.row == index {
                            self.saved = (saved.row, max(0, saved.column - removed))
                        }
                        truncated = true
                    }
                    budget -= keep
                }
            }
        }
        let next = tail(settled)
        if next.count < settled.count { truncated = true; settled = next }
        if settled.count + lines.reduce(0, { $0 + $1.count }) + lines.count - 1 > limit { truncated = true }
    }

    private func tail(_ cells: [Cell]) -> [Cell] {
        guard cells.count > limit else { return cells }
        var start = cells.count - limit
        if let newline = cells[start...].firstIndex(where: { $0.unit == 10 }), newline + 1 < cells.count {
            start = newline + 1
        }
        if start < cells.count, (0xDC00...0xDFFF).contains(cells[start].unit) { start += 1 }
        return Array(cells[start...])
    }

    private func escapeEnd(_ input: [UInt16], at index: Int) -> Int? {
        guard index + 1 < input.count else { return nil }
        let next = input[index + 1]
        if next == 91 {
            return input.indices.dropFirst(index + 2).first(where: { (64...126).contains(input[$0]) }).map { $0 + 1 }
        }
        if [93, 80, 88, 95, 94].contains(next) {
            var cursor = index + 2
            while cursor < input.count {
                if input[cursor] == 7 { return cursor + 1 }
                if input[cursor] == 10 { return cursor }
                if input[cursor] == 27 {
                    guard cursor + 1 < input.count else { return nil }
                    if input[cursor + 1] == 92 { return cursor + 2 }
                }
                cursor += 1
            }
            return nil
        }
        if [40, 41, 42, 43].contains(next) { return index + 2 < input.count ? index + 3 : nil }
        return index + 2
    }

    private mutating func move(row: Int, column: Int) {
        self.row = min(max(0, row), lines.count - 1)
        self.column = min(Self.tailLimit, max(0, column))
    }

    private mutating func eraseLine(_ mode: Int) {
        switch mode {
        case 0: lines[row] = Array(lines[row].prefix(column))
        case 1:
            let end = min(column + 1, lines[row].count)
            lines[row].replaceSubrange(0..<end, with: repeatElement(Cell(unit: 32, style: 0), count: end))
        default: lines[row] = []
        }
    }

    private mutating func escape(_ sequence: [UInt16]) {
        guard sequence.count >= 2 else { return }
        if sequence[1] != 91 {
            switch sequence[1] {
            case 55: saved = (row, column)
            case 56: if let saved { move(row: saved.row, column: saved.column) }
            case 77: move(row: row - 1, column: column)
            default: break
            }
            return
        }
        let parameters = String(decoding: sequence.dropFirst(2).dropLast(), as: UTF16.self)
        guard !["?", ">", "="].contains(parameters.first.map(String.init) ?? "") else { return }
        let numbers = parameters.split(separator: ";", omittingEmptySubsequences: false).flatMap { parameter -> [Int] in
            var parts = parameter.split(separator: ":", omittingEmptySubsequences: false).map { min(Self.tailLimit, max(0, Int($0) ?? 0)) }
            if parts.count >= 6, [38, 48].contains(parts[0]), parts[1] == 2 { parts.remove(at: 2) }
            return parts
        }
        let count = max(1, numbers.first ?? 1)
        switch sequence.last {
        case 109: applyStyle(numbers)
        case 65: move(row: row - count, column: column)
        case 66: move(row: row + count, column: column)
        case 67: move(row: row, column: column + count)
        case 68: move(row: row, column: column - count)
        case 69: move(row: row + count, column: 0)
        case 70: move(row: row - count, column: 0)
        case 71: move(row: row, column: count - 1)
        case 72, 102: move(row: count - 1, column: max(1, numbers.dropFirst().first ?? 1) - 1)
        case 75: eraseLine(numbers.first ?? 0)
        case 74:
            switch numbers.first ?? 0 {
            case 0: eraseLine(0); lines = Array(lines.prefix(row + 1))
            case 1:
                for index in 0..<row { lines[index] = [] }
                eraseLine(1)
            case 3:
                if !settled.isEmpty { truncated = true }
                settled = []
            default: lines = [[]]; row = 0; column = 0
            }
        case 115: saved = (row, column)
        case 117: if let saved { move(row: saved.row, column: saved.column) }
        default: break
        }
    }

    private mutating func applyStyle(_ parameters: [Int]) {
        var next = styles[styleIndex]
        next.apply(parameters)
        if let existing = styles.firstIndex(of: next) { styleIndex = existing; return }
        // Bound unique colour-per-character output as well as visible text.
        if styles.count >= 512 {
            lines = lines.map { $0.map { Cell(unit: $0.unit, style: 0) } }
            settled = settled.map { Cell(unit: $0.unit, style: 0) }
            styles = [.init()]
        }
        styleIndex = styles.count
        styles.append(next)
    }
}
