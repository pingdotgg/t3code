# 13 — Security

OWASP Top 10 controls, CI security scanning, and security headers.

## OWASP Top 10 controls

| Risk                          | Control                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| A01 Broken Access Control     | AuthGuard on all protected routes; no client-side-only auth          |
| A02 Cryptographic Failures    | Secrets via Doppler; HTTPS everywhere; never log tokens              |
| A03 Injection                 | Zod validation at all boundaries; Drizzle parameterized queries only |
| A04 Insecure Design           | Problem+JSON error format; PDPL privacy by design                    |
| A05 Security Misconfiguration | Security headers (see below); no debug mode in prod                  |
| A06 Vulnerable Components     | Dependabot + bun audit in CI; Trivy remains future scope             |
| A07 Auth Failures             | Better Auth v1.4; CSRF on by default; rate limiting                  |
| A08 Software Integrity        | TruffleHog in CI; gitleaks pre-commit; SBOM remains future scope     |
| A09 Logging Failures          | pino structured logs; Sentry error tracking; no PII in logs          |
| A10 SSRF                      | Validate and allowlist all outbound URLs in server-side fetch        |

## Security headers

Set these on every response (NestJS `helmet`, Next.js `headers()` config):

```
# Customize per app (nonces/hashes for inline scripts, real API origins for connect-src).
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

## CI security scan pipeline

| Tool                | What it scans                                                     |
| ------------------- | ----------------------------------------------------------------- |
| TruffleHog          | Verified secrets in git history                                   |
| Semgrep             | SAST — OWASP rules, secret patterns, custom rules in `.semgrep/`  |
| bun audit           | Dependency CVEs                                                   |
| Dependabot          | npm/Bun-compatible dependency and GitHub Actions updates          |
| Claude Code Action  | Optional PR security review when Anthropic secrets are configured |
| Trivy (filesystem)  | Future scope — dependencies + config files                        |
| Trivy (Docker)      | Future scope — container image vulnerabilities                    |
| OWASP ZAP           | Future scope — running app HTTP attacks                           |
| gitleaks            | Local/pre-commit secret scanning                                  |
| Anchore (CycloneDX) | Future scope — SBOM generation                                    |

Baseline CI lives in `.github/workflows/security.yml` and runs on PRs, pushes
to `main`, and `workflow_call` from derived repos. Semgrep Cloud upload is
enabled when `SEMGREP_APP_TOKEN` is configured; otherwise CI still runs in OSS
mode.

## On-demand deep audit

Use `/security-audit [target]` when a PR touches auth, secrets, CI workflow
execution, multitenancy, payment/accounting boundaries, or another high-risk
surface. The command runs `scripts/security-audit.sh`, writes reports under
`.local/security-audit/<timestamp>/`, and must stay local-only through Claude
Code CLI. Do not route the Carlini-style probe through a raw API runner.

## Semgrep custom rules

Add project-specific rules in `.semgrep/`:

```yaml
# .semgrep/no-console-log.yaml
rules:
  - id: no-console-log-in-prod
    pattern: console.log(...)
    message: Use pino logger instead of console.log
    severity: WARNING
    languages: [typescript]
```

## Secret scanning (gitleaks)

Configure `.gitleaks.toml`:

```toml
# Prefer narrow paths — a broad *.test.ts allowlist can hide real secrets in tests.
[allowlist]
  paths = [".local/"]
```

Run pre-commit: `gitleaks detect --source . --verbose`

## Consuming repo workflow snippet

```yaml
jobs:
  security:
    uses: <owner>/<repo>/.github/workflows/security.yml@main
```

## OWASP ZAP (DAST)

Run ZAP against the dev/staging environment in CI:

```bash
docker run -t owasp/zap2docker-stable zap-baseline.py \
  -t https://staging.example.com \
  -r .local/zap-report.html
```

Results in `.local/zap-report.html` (gitignored).

## Input validation checklist

- [ ] All user input validated with Zod before use
- [ ] File uploads: type check, size limit, no executable extensions
- [ ] URL parameters: validate and sanitize before use in queries or redirects
- [ ] SQL: never interpolate user input — always use Drizzle ORM or parameterized queries
