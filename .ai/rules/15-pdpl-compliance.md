# 15 — PDPL Compliance (Oman)

Royal Decree 6/2022. Fully enforced since **5 February 2026**.
This rule applies to **every project** regardless of stack.

## Core obligations

| Obligation              | Requirement                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Privacy notice**      | Arabic-language notice mandatory (Art. 4). Must include: data types collected, purpose, legal basis, retention period, rights, DPO contact |
| **Breach notification** | Notify NCSC within **72 hours** of discovery                                                                                               |
| **Data subject rights** | Access, correction, erasure, portability within 30 days                                                                                    |
| **Consent**             | Explicit, informed, withdrawable. Separate consent per purpose                                                                             |
| **Data minimization**   | Collect only what is strictly necessary                                                                                                    |
| **Retention**           | Define and enforce retention periods. Delete after period ends                                                                             |
| **DPO**                 | Data Protection Officer required for systematic processing                                                                                 |

## Data residency

Personal data must be processed in Oman or in countries with "adequate protection" per NCSC determination.
**Cloud provider choice matters**:

- Convex (US-based) may not be adequate for Level 3/4 data without TRA approval
- Render.com: check data center location for each service region

## Opt-in compliance layers

Activate additional rules when applicable:

Financial reporting standards are handled separately. For IFRS Accounting
Standards, load `19-ifrs-compliance.md` when a task touches financial
statements, accounting records, ledgers, revenue recognition, leases,
impairments, audit exports, or IFRS-scoped project requirements.

| Rule                               | When to activate                                                         |
| ---------------------------------- | ------------------------------------------------------------------------ |
| **TRA Cloud** (Decision 1152/2024) | If you are a cloud service provider or storing Level 3/4 government data |
| **CDC** (Royal Decree 64/2020)     | If serving government agencies or critical national infrastructure       |
| **CBO**                            | If handling payments, money transfers, or fintech                        |
| **FSA**                            | If handling investments or securities                                    |
| **MOH**                            | If handling health/medical data                                          |

## Data classification

| Level   | Examples                                    | Special requirements                         |
| ------- | ------------------------------------------- | -------------------------------------------- |
| Level 1 | Public data                                 | None                                         |
| Level 2 | Internal business data                      | Standard PDPL controls                       |
| Level 3 | Sensitive personal data (health, financial) | Encryption at rest + transit; access logging |
| Level 4 | National security, critical infrastructure  | Cannot leave Oman without TRA approval       |

## Technical controls

```ts
// PII columns in schema must be tagged
// -- pdpl:personal  (add as SQL comment)

// Erasure: null out PII, preserve non-PII for business records
await db
  .update(users)
  .set({ email: null, name: null, phone: null, deletedAt: new Date() })
  .where(eq(users.id, userId));

// Audit log every data access (Art. 19)
await auditLog.write({ action: "data.accessed", subjectId, actorId, timestamp });
```

## Development rules

- Never use real PII in tests, seeds, or fixtures — synthetic data only
- Never log PII fields (`email`, `phone`, `nationalId`, `ip`) — use IDs
- In Sentry `beforeSend`: strip PII from `event.user` and related payloads (see `12-telemetry.md` for a scrub pattern)
- `.env.example`: never include real values

## Breach response checklist

- [ ] Isolate affected systems
- [ ] Assess scope (data types, number of subjects affected)
- [ ] Notify NCSC within **72 hours** (pdpl.ncsc.gov.om)
- [ ] If TRA-regulated: notify TRA within **12 hours** for severe breaches
- [ ] Notify affected data subjects if there is high risk to their rights
- [ ] Document in `.local/incidents/breach-YYYY-MM-DD.md`

## Arabic privacy notice

Minimum required sections in Arabic:

1. من نحن وكيفية التواصل معنا (Who we are)
2. البيانات التي نجمعها (Data collected)
3. أغراض المعالجة والأساس القانوني (Purpose + legal basis)
4. مدة الاحتفاظ بالبيانات (Retention period)
5. حقوق أصحاب البيانات (Data subject rights)
6. معلومات مسؤول حماية البيانات (DPO contact)
