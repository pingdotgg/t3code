---
"@effect/sql-mssql": patch
---

**Breaking:** Secure Microsoft SQL Server connections by default by enabling encryption and validating server certificates.

Users connecting to SQL Server instances without TLS must now explicitly set `encrypt: false`. Users connecting with untrusted or self-signed certificates must explicitly set `trustServer: true`.
