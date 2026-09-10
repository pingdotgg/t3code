---
"effect": patch
---

Fix HttpApi authorization decoding.

Previously, `HttpApiBuilder.securityDecode` removed the expected scheme length and one following character from the `Authorization` header without verifying either value. A Bearer decoder could therefore pass credentials from a different scheme such as `Basic`, accept a malformed header without a separating space, or retain leading spaces when more than one separator was present.

The decoder now validates the declared scheme before returning credentials, matches it case-insensitively as required by [RFC 9110 section 11.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-11.1), and consumes one or more separating spaces. Missing, malformed, or mismatched headers produce the existing empty credential value so security middleware can reject them consistently.

Basic authentication previously split the decoded `user-pass` value at every colon, causing otherwise valid passwords containing `:` to be discarded. It now uses only the first colon as the separator and preserves the rest of the password, following [RFC 7617 section 2](https://www.rfc-editor.org/rfc/rfc7617.html#section-2).
