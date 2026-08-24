/**
 * A checked-in, deterministic RSA-2048 Certificate Signing Request for
 * `origin.alchemy-test-2.us` (CN only). Cloudflare's Origin CA signs the
 * CSR's public key and binds the certificate to the `hostnames` passed in
 * the create request (the CSR subject is not authoritative), so the same
 * CSR can be reused across hostname variations in the tests.
 *
 * The matching private key was generated once and intentionally discarded —
 * the tests only exercise issuance/revocation, never TLS handshakes.
 */
export const TEST_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIICaDCCAVACAQAwIzEhMB8GA1UEAwwYb3JpZ2luLmFsY2hlbXktdGVzdC0yLnVz
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5QM++264ptI22f07UORt
BqE6Luc8rBxV84xRidhrHV8HaQbx3i2WFuRVvuVNHoR7XY2ODV211UPah73kUbI6
6iEbMRpYZqJg7+sr8fRImPErg2eZsZ8sekGeoLhhcSqBBC4AxAGzUnxcmhmlODiV
0QK/WgtgrzsiyYOLoAIedk9c8XbrHWa6PWXUah8wDJ4HJysfGVpP9uGVMbk/1+AS
kKzEc/mgly4IMWtnsTjB860S9APtG6Kp6ezxux70BFqQevEUz6pnU7p9jp/6INus
0hXEdv4Mru5UP3+HKujN8Fdts8o0EmAwy9V4NrwfOsV4oW07sEDs1/OzREUzRq0a
cQIDAQABoAAwDQYJKoZIhvcNAQELBQADggEBADRjfs9QVpTg5KbjNPYpVL8yMal9
elc+KlnXiS+62Fn4QBwN016WjzIOwtjpFl5S/rZ5R4HcQA5KJ82Uan42KWCcunY5
evE0ukHVq4v7Eky5ogSARjrRil6HXbPnOYLgUpY2KphzqyGGR1X/U48qai9bUKxC
xn5+vI6VLyJeI8hXZ1YfWICvJceG6sVUIBOwdI05vEr80nckeBH7T1OwhWGUB2Xo
Q6BKHuojZt/qeV+SOEFrMZWJoUQUepivg+YCZkA3L0P5iQ1QV6AQZN13oL0jMW2s
zo6sT++6HK496tkseS1uLHNm5BdlijJtDlXkjCqsI51n5WqsCuSqp9vnz+g=
-----END CERTIFICATE REQUEST-----
`;
