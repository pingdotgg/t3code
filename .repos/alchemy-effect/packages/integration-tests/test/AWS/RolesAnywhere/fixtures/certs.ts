/**
 * Checked-in test fixtures for IAM Roles Anywhere.
 *
 * Generated ONCE with LibreSSL and committed — never regenerated at test
 * time. Both CAs are self-signed EC P-256 / SHA-256 certificates with
 * `basicConstraints=critical,CA:TRUE` and `keyUsage=keyCertSign,cRLSign`
 * (the requirements for a CERTIFICATE_BUNDLE trust anchor), valid until
 * 2036. The CRLs are issued by Test CA 1 (CRL numbers 1 and 2), also valid
 * until 2036.
 *
 * ```sh
 * openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 \
 *   -keyout ca.key -out ca.crt -days 3650 -nodes \
 *   -subj "/CN=Alchemy RolesAnywhere Test CA 1" \
 *   -addext "basicConstraints=critical,CA:TRUE" \
 *   -addext "keyUsage=critical,keyCertSign,cRLSign"
 * openssl ca -config ca.cnf -gencrl -out crl.pem   # crldays 3650
 * ```
 */

export const CA1_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBbjCCARSgAwIBAgIJAK9nK+oFd6lqMAoGCCqGSM49BAMCMCoxKDAmBgNVBAMM
H0FsY2hlbXkgUm9sZXNBbnl3aGVyZSBUZXN0IENBIDEwHhcNMjYwNzEwMjI1MjU2
WhcNMzYwNzA3MjI1MjU2WjAqMSgwJgYDVQQDDB9BbGNoZW15IFJvbGVzQW55d2hl
cmUgVGVzdCBDQSAxMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcdbMumw7SDrB
CLM2meygNjDjzuHOpr8lOdd7OOdfXe7t3pLmm+SqU9jfy80WZyhC9J5GhbwKnJuh
5bp4/GWS1KMjMCEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYI
KoZIzj0EAwIDSAAwRQIgQ2QgLO89swCMp5UZoUvLq+VoRIfexB+iSk92m1DaBWsC
IQDuogiep3r3olS/8UmzimHiCH167d0vGB5CFRnkKSSj0Q==
-----END CERTIFICATE-----`;

export const CA2_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBbTCCARSgAwIBAgIJAIgBUdSkfA0AMAoGCCqGSM49BAMCMCoxKDAmBgNVBAMM
H0FsY2hlbXkgUm9sZXNBbnl3aGVyZSBUZXN0IENBIDIwHhcNMjYwNzEwMjI1MjU2
WhcNMzYwNzA3MjI1MjU2WjAqMSgwJgYDVQQDDB9BbGNoZW15IFJvbGVzQW55d2hl
cmUgVGVzdCBDQSAyMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtT8ZNO2J3Igt
4tIpIYwKQZ9RSYty5FHE96egbgRWWpI/iErOGJXk+Xdp+AabFUMB/Qi41P11ocJO
mJIn2ULHMqMjMCEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYI
KoZIzj0EAwIDRwAwRAIgZbkvQhO65WNfctjY9csDIdO8Vw9peumgKbwzjs9DPGsC
IHRWVLwLqB3bukO3ifYaDXqUjv66105QNBlztMf/Z2rp
-----END CERTIFICATE-----`;

/**
 * CRL number 1, issued by Test CA 1, containing one revoked leaf
 * certificate (IAM Roles Anywhere rejects CRLs with no revoked entries).
 */
export const CRL1_PEM = `-----BEGIN X509 CRL-----
MIHaMIGAAgEBMAoGCCqGSM49BAMCMCoxKDAmBgNVBAMMH0FsY2hlbXkgUm9sZXNB
bnl3aGVyZSBUZXN0IENBIDEXDTI2MDcxMDIyNTM1N1oXDTM2MDcwNzIyNTM1N1ow
FTATAgIQABcNMjYwNzEwMjI1MzU3WqAOMAwwCgYDVR0UBAMCAQEwCgYIKoZIzj0E
AwIDSQAwRgIhAPt5nysnFXx4GserJT6r8VHNzUBfj+dYwEJDMd8CfraJAiEAsaqe
GRjgUIb+wtNWbLW+JDrX9lg+KARuCWT2xtxQy+Q=
-----END X509 CRL-----`;

/**
 * CRL number 2, issued by Test CA 1, containing two revoked leaf
 * certificates — a rotation of {@link CRL1_PEM}.
 */
export const CRL2_PEM = `-----BEGIN X509 CRL-----
MIHvMIGVAgEBMAoGCCqGSM49BAMCMCoxKDAmBgNVBAMMH0FsY2hlbXkgUm9sZXNB
bnl3aGVyZSBUZXN0IENBIDEXDTI2MDcxMDIyNTM1N1oXDTM2MDcwNzIyNTM1N1ow
KjATAgIQABcNMjYwNzEwMjI1MzU3WjATAgIQARcNMjYwNzEwMjI1MzU3WqAOMAww
CgYDVR0UBAMCAQIwCgYIKoZIzj0EAwIDSQAwRgIhAOYO6BuWRt/bziGOGXUg7LCZ
vDU25rt0DrPR9EMw0gBIAiEAy3PnEQZmn0tecbVpKnMgWEvgfLoRU9XqBTPL6jL7
rFY=
-----END X509 CRL-----`;
