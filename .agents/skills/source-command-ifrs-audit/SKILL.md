---
name: "source-command-ifrs-audit"
description: "Scan the current codebase for IFRS Accounting Standards compliance gaps."
---

# source-command-ifrs-audit

Use this skill when the user asks to run the migrated source command `ifrs-audit`.

## Command Template

Perform an IFRS Accounting Standards compliance audit of the current codebase.

Reference: `.ai/rules/19-ifrs-compliance.md`

Scan for:

### 1. Scope and applicability

- Check `docs/project.md` reporting standards selection
- Flag financial-reporting features when IFRS scope is unset
- Confirm IFRS is not mixed into PDPL-only privacy checks

### 2. Monetary precision

- Search for `number`, `float`, `double`, or JavaScript arithmetic used for money
- Confirm decimal-safe handling for monetary calculations
- Confirm currency codes are stored explicitly

### 3. Accounting records

- Confirm transaction date, posting date, reporting period, status, source
  reference, and created/approved metadata where relevant
- Confirm posted records are not overwritten silently
- Confirm draft, posted, voided, and reversed states are distinct where relevant

### 4. Audit trail

- Confirm accounting mutations are traceable by actor, timestamp, source, and reason
- Confirm corrections use adjustments, reversals, or versioned history

### 5. Period close and reversals

- Confirm closed periods cannot be mutated without controlled adjustments
- Confirm void/reversal behavior exists for posted records

### 6. Reports and exports

- Confirm financial statements include reporting period and basis of preparation
- Confirm exports are reproducible from persisted source records
- Confirm comparative-period behavior exists or is explicitly out of scope

### 7. Disclosure and notes

- Flag missing accounting-policy note support where the app generates formal
  financial statements
- Flag missing materiality/disclosure inputs where formal IFRS reports are claimed

### 8. Tests

- Confirm tests cover rounding, currency conversion, period boundaries, reversals,
  report reproducibility, and audit logging

### Output format

Return findings grouped by severity:

- **Critical** — immediate financial-reporting integrity risk
- **High** — must fix before audited or investor-facing reporting
- **Medium** — fix before expanding finance/reporting scope
- **Low** — documentation, process, or explicit-scope gap

End with a summary checklist of compliant items.
