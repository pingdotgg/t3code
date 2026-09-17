---
"effect": patch
---

Align Schema adapter failures: `Schema` result, promise, and sync adapters now surface `SchemaError`, while `SchemaParser` result, promise, and sync adapters expose `SchemaIssue.Issue`. Mark `SchemaParser` option adapters as internal because their error details are discarded.
