---
description: Scan the current codebase for PDPL (Oman Royal Decree 6/2022) compliance gaps.
---

Perform a PDPL compliance audit of the current codebase.

Reference: `.ai/rules/15-pdpl-compliance.md`

Scan for:

### 1. PII in non-production contexts

- Search tests, seeds, fixtures for real email patterns, phone numbers, national IDs
- Search git history for any PII accidentally committed
- Flag: `test@gmail.com`, Omani phone patterns (`+968 9...`), names in test data

### 2. Logging

- Search pino/console.log calls that include `email`, `phone`, `nationalId`, `ip`
- Confirm Sentry `beforeSend` strips user PII fields

### 3. Data schema

- Check DB schema for PII columns — confirm they have `-- pdpl:personal` comments
- Verify soft-delete pattern exists for user tables
- Confirm erasure path exists

### 4. Privacy notice

- Confirm Arabic-language privacy notice exists in `messages/ar.json`
- Confirm it covers: data types, purpose, legal basis, retention, rights, DPO contact

### 5. Consent

- Confirm consent flows are explicit and separate per purpose
- Confirm withdrawal mechanism exists

### 6. Data residency

- Note which cloud providers store data and in which regions
- Flag any Level 3/4 data stored outside Oman without documented TRA approval

### 7. Breach response

- Confirm production environment variables are set correctly (no localhost or development-only values where production URLs are required)
- Check if a breach notification runbook exists (`.local/incidents/` or similar)

### Output format

Return findings grouped by severity:

- **Critical** — immediate compliance risk (e.g. real PII in tests)
- **High** — must fix before next release
- **Medium** — fix within 30 days
- **Low** — documentation or process gap

End with a summary checklist of compliant items.
