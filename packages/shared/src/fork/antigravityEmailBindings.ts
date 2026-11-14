import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const normalizedEmail = (email: string | undefined) => email?.trim().toLowerCase() || undefined;

/** A hub that withholds `userinfo` names an Antigravity account only by its e-mail. */
export function bindAntigravityEmails(
  reports: readonly AccountReport[],
): (report: AccountReport) => AccountReport {
  const fingerprints = new Map<string, string>();
  const claimedTwice = new Set<string>();
  for (const { driver, usageLimits } of reports) {
    const email = normalizedEmail(usageLimits?.credentialEmail);
    const fingerprint = usageLimits?.credentialFingerprint;
    if (driver !== "antigravity" || !email || !fingerprint) continue;
    const bound = fingerprints.get(email);
    if (bound !== undefined && bound !== fingerprint) claimedTwice.add(email);
    fingerprints.set(email, fingerprint);
  }
  if (fingerprints.size === 0) return (report) => report;
  return (report) => {
    const email = normalizedEmail(report.email);
    if (report.driver !== "antigravity" || !email || !report.usageLimits) return report;
    if (report.usageLimits.credentialFingerprint || claimedTwice.has(email)) return report;
    const fingerprint = fingerprints.get(email);
    return fingerprint
      ? {
          driver: report.driver,
          usageLimits: { ...report.usageLimits, credentialFingerprint: fingerprint },
        }
      : report;
  };
}
