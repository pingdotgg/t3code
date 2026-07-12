public enum HighlightLanguage: String, Sendable {
    var alias: String {
        switch self {
        case .cPlusPlus: return "cpp"
        case .latex: return "tex"
        case .phpTemplate: return "phptemp"
        case .protocolBuffers: return "protobuf"
        case .pythonRepl: return "python-repl"
        case .visualBasic: return "vbnet"
        case .webAssembly: return "webass"
        default:
            return rawValue.lowercased()
        }
    }

    case appleScript
    case arduino
    case awk
    case bash
    case basic
    case c
    case cPlusPlus
    case cSharp
    case clojure
    case css
    case dart
    case delphi
    case diff
    case django
    case dockerfile
    case elixir
    case elm
    case erlang
    case gherkin
    case go
    case gradle
    case graphQL
    case haskell
    case html
    case java
    case javaScript
    case json
    case julia
    case kotlin
    case latex
    case less
    case lisp
    case lua
    case makefile
    case markdown
    case mathematica
    case matlab
    case nix
    case objectiveC
    case perl
    case php
    case phpTemplate
    case plaintext
    case postgreSQL
    case protocolBuffers
    case python
    case pythonRepl
    case r
    case ruby
    case rust
    case scala
    case scss
    case shell
    case sql
    case swift
    case toml
    case typeScript
    case visualBasic
    case webAssembly
    case yaml
}
