---
"effect": patch
---

Terminate active multipart file streams when a parser limit is exceeded or the body ends unexpectedly, so file parts fail instead of hanging.
