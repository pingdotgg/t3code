/**
 * Deterministic test CSRs for ClientCertificate tests.
 *
 * Generated once with openssl (RSA-2048) and checked in so that every test
 * run submits identical content — a ClientCertificate's cold-read identity is
 * the (csr, validityDays) pair, so the CSR must be byte-stable across runs:
 *
 * ```sh
 * openssl req -newkey rsa:2048 -nodes -keyout a.key -out a.csr \
 *   -subj "/CN=alchemy-client-cert-a.alchemy-test-2.us/O=Alchemy/C=US"
 * # b.csr likewise with CN=alchemy-client-cert-b.alchemy-test-2.us
 * ```
 *
 * Only the CSRs are checked in — the private keys are not needed by any test
 * and were discarded.
 */

/** CSR for CN=alchemy-client-cert-a.alchemy-test-2.us (create/destroy test). */
export const CSR_A = `-----BEGIN CERTIFICATE REQUEST-----
MIICljCCAX4CAQAwUTEwMC4GA1UEAwwnYWxjaGVteS1jbGllbnQtY2VydC1hLmFs
Y2hlbXktdGVzdC0yLnVzMRAwDgYDVQQKDAdBbGNoZW15MQswCQYDVQQGEwJVUzCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMk5scneE+7VYOyrVnCsamkT
b6aLuSagcljdChpF0s1bbbEx5x2Aqe2MX/zPjNpiCbtFvWaygDiiqSUEx0PgimYR
Jo87e6DoTIIXcz1zRqP0eyI3+RiaqP/2s7rk5I7m5c2LW1bnRUBAV0Dop1q7Ihn4
ZJQRwN8IiTPiez8e53KlizrudvMZxnam4lB/70a63yBO/LI1mZ60KfVZqTx6JAUP
nGO+oz/A/oTIDwuhDvZvGfMEdijoPvKbt0YKXt9ApU8CKEPZdHjdL4Hp4rz2THl0
+52vmLAj3w0lc+B04iBjsPaKMiAyyD+KHmv4fBMpuWafcyYlC+qQydMvGydK1e0C
AwEAAaAAMA0GCSqGSIb3DQEBCwUAA4IBAQC0YeP3J6Dj91FCIBstCzzAZ4cIzZYQ
MUG6ODPT1bF1y2rjAxrznJrLUMyYtE+LbndZ1Nuw3dqvhIux7pG8VrmI13EJ2ueK
u92CCuFCB/DfwCmzOpg7tO2cKTxJCmim8EiiSvBEBSsk8l44k6B3h2LYRqB8bjzV
sH0mUhkwBvBb3IOrEQRPVBNWzNZxAdHeMXd0ZyKx/1btvVpfYv03xPKBKNJNPkef
yQQMTuMWXStRepZFMMOX14nMZwPNTXNvAVhk9U0ARX1Ve45QkmhFK4hj2U9zMa7Z
cpFSabfBH9n/EMoH6fPp1th1ehZTRSa8pagmjEa7BFF2xQNVQlHIYRRf
-----END CERTIFICATE REQUEST-----
`;

/** CSR for CN=alchemy-client-cert-b.alchemy-test-2.us (replacement test). */
export const CSR_B = `-----BEGIN CERTIFICATE REQUEST-----
MIICljCCAX4CAQAwUTEwMC4GA1UEAwwnYWxjaGVteS1jbGllbnQtY2VydC1iLmFs
Y2hlbXktdGVzdC0yLnVzMRAwDgYDVQQKDAdBbGNoZW15MQswCQYDVQQGEwJVUzCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKf3LjkvRaLidxxn7SrzvTbU
vd+ixmDcuk7gXNu8BQfsDcDeR5ZGUxvIhdc+bdmyFRyoHJQ3DooL7Kge26LAaAMB
irqAwyWzv+72E8F4YJXFKmTyUibBz7aE9NrJnYYtKROaQwE8y3+LIf0NIqmqLOnl
aVITXYOjgL4eHbekodfBhXk2CCamZOAFHcBlf/xJGqLKHXQo2QEyDmEz79ueiOlg
suctQehldB6N642PK55K3seJ6U7MEjq1MLufpS+Mva62PfWpaBUF2xlDra3ZMKa7
hhHTSLHLxSqZ/5t3xMhIbOl8ZVbws2n34Qf7LDEeY7EQrrWya94eJgBbXCCYaUMC
AwEAAaAAMA0GCSqGSIb3DQEBCwUAA4IBAQCSx2GL43F2EQiRoYHDepT+paMhlJgc
TH2TyQis6DW07cAlBjX2cYeP3unyR/sJl0V6tdHU53SRfsHC847PPSrQYXLYwdNs
5mQ3y4uyfgdQUWnl6HvhEGdmrZLfh7gUtZG6V+q12ZD3o6mGR1WC7V2P47AjQ4to
jnR7gK1OS+EH4Fciwn1gJ4W+xOZRgp1SAOLHa1pEhqbeE0O1E9be68ctezB8xmbQ
9fTDrlFJmqmsmLwgqZBeY2VR6qtv0oENlUwkya6OLVfjBcRx03fmb0f1kbcUtc7u
AoxFoyNdr3WTR2eiUGfUpKN3PPLsXc5GkatBRF3MjEC05UtIZzIT/6ZZ
-----END CERTIFICATE REQUEST-----
`;
