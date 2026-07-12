public enum HighlightMode: Hashable, Sendable {
    /// Detect the language automatically
    case automatic

    /// Use a specific language alias string
    case languageAlias(String)

    /// Use a specific language alias string and continue past illegal matches
    case languageAliasIgnoreIllegal(String)

    /// Use a specific language
    case language(HighlightLanguage)

    /// Use a specific language and continue past illegal matches
    case languageIgnoreIllegal(HighlightLanguage)
}
