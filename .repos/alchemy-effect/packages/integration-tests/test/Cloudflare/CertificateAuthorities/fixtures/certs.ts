/**
 * Deterministic CA certificates for HostnameAssociation tests.
 *
 * Generated once with openssl (RSA-2048, 10-year validity) and checked in so
 * that every test run uploads identical content (distinct from the
 * MtlsCertificate suite's fixtures — Cloudflare rejects uploading identical
 * PEM content twice on the same account):
 *
 * ```sh
 * openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem \
 *   -days 3650 -subj "/CN=Alchemy CertAuth Test CA 1/O=Alchemy/C=US" \
 *   -addext "basicConstraints=critical,CA:TRUE" \
 *   -addext "keyUsage=critical,keyCertSign,cRLSign"
 * # CA 2 likewise with CN=Alchemy CertAuth Test CA 2
 * ```
 */

/** Self-signed root CA "Alchemy CertAuth Test CA 1" (expires 2036). */
export const CA_CERT_1 = `-----BEGIN CERTIFICATE-----
MIIDLjCCAhagAwIBAgIJAJ81r+I3C4azMA0GCSqGSIb3DQEBCwUAMEQxIzAhBgNV
BAMMGkFsY2hlbXkgQ2VydEF1dGggVGVzdCBDQSAxMRAwDgYDVQQKDAdBbGNoZW15
MQswCQYDVQQGEwJVUzAeFw0yNjA2MTIwMTU1MjNaFw0zNjA2MDkwMTU1MjNaMEQx
IzAhBgNVBAMMGkFsY2hlbXkgQ2VydEF1dGggVGVzdCBDQSAxMRAwDgYDVQQKDAdB
bGNoZW15MQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBALNaNABcTEwsMANJYI+ZCNw1OCUR7VBBrh4xDHzDlqvSQEAuXcDFRM6ftAEC
I/9rfOWK8P4Csnk1tO1+QwMkyZmTYNvXHYOY/ZoQBw8R96SxkHn/po3LrvcO9WH+
lsepsY25EZGfXLPC2M9uhbMPgHPDfBe1ffnNWVL96ua2g62B9uvpBX0Lj+/k+6lU
6Vgc44MFdDIi2XjcciPnFoO8FUCA83qCAd4fvcZXnzqIMFK4PaIcpkkdBa8Xw3gJ
6ZGVH4iNnBsXx8TMZromU4zh3q98BbT8roKZKigeP/0ixweLe+PhM9DGu1BADoD4
94UASMVsV4PP5bo59T0mFAle+jMCAwEAAaMjMCEwDwYDVR0TAQH/BAUwAwEB/zAO
BgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAKzJBpPbUmtvlPOdpQPS
rBpSVgcJjXj5KM/1+mDGHe2phq61wk4LlBUghdAyg3dqGPZj0iXkPosv3E7UeIwZ
cDSFBZLKTJhJzhSUohSmwh0GE8u10+Ws2aivK12cW/pud8eN1ho48JqdVz098d7Q
b/XXjZ+tNfTCHxNe27hsq8A+3hoNWiJ5eRezcXR6Kla4+TE3YxGG2/yhVytPlJwj
6LmCfTLS1Hww5UBSUUrVnMXxiLELG4/O4ceTxObsKv4uGpW0AvNIlOOLN7dIvqXj
TqdUrzLZ47nVX9yg34T4wr/TKA3vDPfAVkTrnBIZRsrTNXRmRZXwMi56bdOnj/W8
svs=
-----END CERTIFICATE-----
`;

/** Self-signed root CA "Alchemy CertAuth Test CA 2" (expires 2036). */
export const CA_CERT_2 = `-----BEGIN CERTIFICATE-----
MIIDLjCCAhagAwIBAgIJAPGLvLtGafh9MA0GCSqGSIb3DQEBCwUAMEQxIzAhBgNV
BAMMGkFsY2hlbXkgQ2VydEF1dGggVGVzdCBDQSAyMRAwDgYDVQQKDAdBbGNoZW15
MQswCQYDVQQGEwJVUzAeFw0yNjA2MTIwMTU1MjNaFw0zNjA2MDkwMTU1MjNaMEQx
IzAhBgNVBAMMGkFsY2hlbXkgQ2VydEF1dGggVGVzdCBDQSAyMRAwDgYDVQQKDAdB
bGNoZW15MQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAONpUB/nAygfxAkKmsru5nZVm5L34+6C08pd8lra8/SBg1kQf791LakvdK+H
8vJEWxmYn+TWQaDDp268XBmVlYF//c2xzGB5iEjCKsX0ODkF8TBb6ZfUrIoINhvu
2QTeEiiZ0Jfc8GP4bv9Nwa4z6WKUjUBH6sUtkTbPCrqnhJnvlCfUki64fMP0UZCO
OS7ZgvA/bYcQuahNGIg8lEjPC5PaONAHHP+K/QtquLjFgtrq44iymE9xXHYo1w4U
qnsVxcrzY7p1b75kD9si/k7aVkLIAZhT+medmCXVmwr6WsLJdLagZgTs4erL2B14
t1835pU/nLFNOxnUbVkguZOtX+8CAwEAAaMjMCEwDwYDVR0TAQH/BAUwAwEB/zAO
BgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAGk+o7Qcngagk9crjCZH
hr0YblkA7r/BOdRCgAYGPO3ihJld3yPmB/QUaAPpzQbIQrICrp9HE16kvN90QGr5
X7UEJLkAwlgR02gZmmuSw9SEKkK3HsZomFuwgsdXonBXM6npAaVd4LyKpyB5rICh
zNHRDOSWPic8e8BMhms6pviFOEP014QmGMG8CcSxtA3bGvZk5SXZIK2xTHg10dLE
2rwvuHhbxELGI4gMGJCgS0C13Rxe468kqpxSK4wNjx7Iaz/O/yXXsYyDQ/s62irX
0P/PY5Ipj7sPImMCWa/ugN/fjWVdejiFwmZHgcK5f3ihRcBVWLbXpUTjUvOUM618
y9Q=
-----END CERTIFICATE-----
`;
