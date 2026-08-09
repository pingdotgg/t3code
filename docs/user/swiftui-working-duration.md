# SwiftUI Mobile Working Duration

In the SwiftUI iOS app, an active thread shows a live working-duration indicator in the thread header and transcript. When a start time is known, the indicator updates about once per second and uses compact values such as `42s`, `1m`, and `1h 31m`.

If a start time is not available, the app keeps the working status without inventing a duration. When the agent stops working, the transcript indicator is removed and the header returns to the normal thread status.

The header and working row spell the duration out for VoiceOver. The working row also announces that new output will appear there.
