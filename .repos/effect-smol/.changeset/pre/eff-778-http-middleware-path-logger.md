---
"effect": patch
---

Update the unstable HTTP middleware logger to annotate only the request path in `http.url` instead of including the full URL (query / fragment), and add a regression test.
