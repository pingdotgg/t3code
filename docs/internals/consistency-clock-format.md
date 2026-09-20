# Consistent clock preferences

Proposed constraint: an explicit clock preference applies to every wall-clock
label in the client that offers it, including errors, account and connection
details, and tooltips. Switching between 12-hour, 24-hour and locale formatting
updates mounted content without reloading. Formatting belongs to the viewing
client; connecting to a remote environment must not substitute the server's
locale or preference.

This applies the principles of clear, consistent meaning and respecting user
choices to timestamps; it is not a broader localization redesign. Design
references: Apple HIG [Writing](https://developer.apple.com/design/human-interface-guidelines/writing)
and [Settings](https://developer.apple.com/design/human-interface-guidelines/settings).

Web and Electron use the client-local `timestampFormat` setting and the cached
formatters in [timestampFormat.ts](../../apps/web/src/timestampFormat.ts).
Full details retain their calendar date and year; clocks that need seconds
retain that precision. Missing or invalid timestamps keep their caller's
existing fallback rather than throwing or inventing a time. Labels representing
the same instant may use different precision when their tasks differ.

Relative ages, elapsed durations, countdowns, date-only labels, ISO payloads and
logs have different meanings and do not take the clock preference. Native date
and time inputs follow their supported platform behavior. React Native has its
own [device preferences](../../apps/mobile/src/persistence/mobile-preferences.ts),
with no app-level clock override at this baseline; its locale-formatted clocks
and native pickers follow platform behavior. Web settings must not be treated
as a global preference shared with that client. SwiftUI is outside this scope.

Acceptance requires changing the preference with chat, request-error details,
provider sign-in expiry, pull-request timestamps and account/connection details
already mounted: every affected wall-clock label updates, dates remain present
in full details, and invalid values remain safe. Repeat explicit 12-hour and
24-hour choices under locales with opposite defaults, then restore locale mode.
Local and remote connections must produce the same clock style in the same
viewing client. Formatter tests establish formatting behavior; a real-client
pass is required to establish live updates and surface coverage.
