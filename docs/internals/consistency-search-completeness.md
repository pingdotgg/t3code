# Search scope and completeness

Proposed behavioral contract; not maintainer ratification. This applies to thread
search in web/Electron sidebars and command palettes, and React Native home,
thread navigation and command palettes. Navigation return and filter clearing are
separate concerns.

A search covers its selected environments even when one disconnects. No request
currently pending does not mean every source answered. Keep successful matches
and the query while another source fails. Name unavailable environments beside
results, including when there are no matches; offer retry for failed requests and
the existing connection settings route for unavailable environments. Reconnection
and retry must update the same query without clearing other environments' matches.
Cached matches remain usable but must be identified while refreshing or after a
failed refresh.

Distinguish pending, failed, disconnected and unsupported message search from a
completed search with no matches. Local title matching remains available on older
servers. An unsupported message-search RPC is not evidence that a title search
failed. Empty, one-character and invalid queries remain ordinary local search
states, without connection errors or a permanently pending indicator.

Completeness is relative to scope: message search covers unarchived threads,
user messages and final assistant responses, not reasoning or streaming output.
The server returns at most 50 message matches per environment. At that limit,
report that more may exist and suggest refining the query; the response does not
prove truncation. Local title results and active filters can further affect the
visible set. Do not promise an exhaustive archive search.

Observable cases: two environments answer successfully; one answers while another
is pending, fails or disconnects; both fail; cached matches survive revalidation
failure; an older server cannot search messages but its local titles still match;
a capped response is qualified; and recovery replaces the unavailable state
without changing the query or dropping the other environment's results. Show
status with nonempty results as well as empty results on every listed surface.

The rationale follows Apple's public [Searching](https://developer.apple.com/design/human-interface-guidelines/searching),
[Loading](https://developer.apple.com/design/human-interface-guidelines/loading)
and [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)
guidance: communicate search scope, ongoing work and recoverable problems. This
contract is T3's proposed application of those principles, not an Apple requirement
for identical controls across platforms.
