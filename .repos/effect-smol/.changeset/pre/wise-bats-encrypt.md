---
"effect": patch
---

Use a distinct AES-GCM initialization vector for each encrypted event log entry. `EventLogEncryption.encrypt` now returns each IV with its ciphertext, and encrypted event log clients and servers must be upgraded together because the `WriteEntries` wire shape changed.
