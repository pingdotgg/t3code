# 19 — IFRS Accounting Standards

Full IFRS Accounting Standards engineering guidance. Load this rule when a task
touches financial statements, accounting ledgers, revenue recognition, leases,
impairments, audit exports, accounting reports, or IFRS-scoped project
requirements.

This rule applies to both stacks. It does not cover IFRS for SMEs, IFRS S1/S2
sustainability disclosures, IFRS 17 insurance-specific reporting, tax filing
rules, XBRL/iFile submission, or professional accounting advice unless another
project rule explicitly opts in.

## Core obligations

| Area                            | Engineering requirement                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Financial statements**        | Support complete statement sets when the product generates formal IFRS reports: financial position, profit or loss and other comprehensive income, changes in equity, cash flows, and notes/accounting policies |
| **Comparatives**                | Preserve prior-period data needed for comparative reporting                                                                                                                                                     |
| **Materiality and disclosures** | Track report basis, reporting period, accounting policies, estimates, and disclosure inputs where formal statements are generated                                                                               |
| **Audit trail**                 | Every accounting mutation must record actor, timestamp, source, reason, and adjustment path                                                                                                                     |
| **Period close**                | Closed periods cannot be changed silently; use controlled adjustments or reversals                                                                                                                              |
| **Reconciliation**              | Reports and exports must be reproducible from persisted source records                                                                                                                                          |

## Accounting data rules

- Use decimal-safe money handling. Never use floating-point arithmetic for
  monetary amounts.
- Store ISO currency codes explicitly on monetary records.
- Preserve transaction date, posting date, reporting period, created metadata,
  approved metadata, and source-document references where relevant.
- Separate draft, posted, voided, and reversed states.
- Never silently overwrite posted accounting records. Use correcting entries,
  reversals, or versioned adjustments.
- Multi-currency records must preserve original transaction currency, functional
  currency, exchange-rate source, and rate date.
- Generated financial reports must state reporting period and basis of
  preparation.
- Financial exports must be deterministic and reproducible from persisted
  records, not one-off calculations.

## Development rules

- If `docs/project.md` selects `IFRS Accounting Standards`, load this rule for
  all finance/accounting work.
- If a task touches financial reporting and `docs/project.md` does not select a
  financial reporting standard, stop and confirm scope before implementation.
- If `docs/project.md` is still in template state, follow the bootstrap gate
  unless the change is product-agnostic template maintenance.
- If a feature claims IFRS readiness without audit trails, period controls, or
  reproducible reports, flag it as a compliance gap.

## Tests

Cover these scenarios for accounting/reporting behavior:

- Monetary rounding and precision
- Currency conversion and rate-date handling
- Posting, voiding, and reversal flows
- Closed-period mutation attempts
- Report reproducibility from source records
- Comparative-period reporting where formal statements are generated
- Audit logging for accounting mutations

## Oman note

IFRS is common in Oman financial-reporting contexts, especially for companies
subject to FSA, CBO, audit, or lender reporting obligations. Always verify the
project-specific regulator and reporting scope in `docs/project.md`.
