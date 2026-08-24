/**
 * Static self-signed certificate fixtures for `alchemy-test-2.us`, generated
 * once with:
 *
 * ```sh
 * openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
 *   -subj "/CN=alchemy-test-2.us" \
 *   -addext "subjectAltName=DNS:alchemy-test-2.us,DNS:*.alchemy-test-2.us"
 * ```
 *
 * The private keys were discarded — Keyless SSL only ever uploads the
 * certificate (the key stays on the external key server), so the certs alone
 * are sufficient (and deterministic) test inputs. Valid until 2036.
 */

/** Self-signed cert for `alchemy-test-2.us` + `*.alchemy-test-2.us`. */
export const CERT_1 = `-----BEGIN CERTIFICATE-----
MIIC8DCCAdigAwIBAgIJAOACwq9umsBPMA0GCSqGSIb3DQEBCwUAMBwxGjAYBgNV
BAMMEWFsY2hlbXktdGVzdC0yLnVzMB4XDTI2MDYxMjAyMTUxOFoXDTM2MDYwOTAy
MTUxOFowHDEaMBgGA1UEAwwRYWxjaGVteS10ZXN0LTIudXMwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQCtJ6FcLIUHvNbq5v7ko0cDUMjaugrk2GgyHnCE
ncTlO3x366W5qeuMf+j30vZCa2I+T2aZlC55W9CGARuGKjUScB1E+OpkTtiaaJpW
CUN/29vVNn1OGbUQwf5mKkyv2rpI5epDGbOvYXjHIPwk/WnINvLPAJ+XPhCG+Ixg
b8kIenWynwPT2Ot/elvtwP/H+nIjmBuugPGELD4qsEuE2AkqJtzJN+OvVjp72Mhf
TJJgc8Nenuc4gs6f6rCygXqu0CStl2hY1viKhsiLC+ZF7y6XpM8Ke2xQCzQtv7ls
bO0UJZvqHVLSaH3grS7BhZ/Yj/0dWvaqqPr7wE7qqQ91MZVpAgMBAAGjNTAzMDEG
A1UdEQQqMCiCEWFsY2hlbXktdGVzdC0yLnVzghMqLmFsY2hlbXktdGVzdC0yLnVz
MA0GCSqGSIb3DQEBCwUAA4IBAQCA2lj/q6n35NNvPdxZG0rhxLM6DVN3zeq/pIoi
b7/6dao8Cd3v8lJOEzRGwGM1hA/MLN+33fC3tnl1pY+ciVLd7SNWAYX63ZOTOf9v
TSFT6EKMWUlOiYImk7YoDD0w67/xLxjLiJhLIucx5S4BhihJnWt5Vl05WLHAEAAw
wK+GGvSSHmCAelwN9+0sAg47tBAx4UuGlVL2Yu42GtU1qfI2nuzJnWhjlmeCJxq+
b1POIF4+AEyLm2UZhZVCThS8XpYNVm53miBihGaTJOUyOE/ElPhlPHK+LjlispaY
qD4uMB3EsPdkZCRXKw5sIY0B4kibggImlTuiw4fylqI8Iq9f
-----END CERTIFICATE-----`;

/** A second, distinct self-signed cert for `alchemy-test-2.us` (rotation). */
export const CERT_2 = `-----BEGIN CERTIFICATE-----
MIIC2zCCAcOgAwIBAgIJANb+J9xWS7KqMA0GCSqGSIb3DQEBCwUAMBwxGjAYBgNV
BAMMEWFsY2hlbXktdGVzdC0yLnVzMB4XDTI2MDYxMjAyMTUxOFoXDTM2MDYwOTAy
MTUxOFowHDEaMBgGA1UEAwwRYWxjaGVteS10ZXN0LTIudXMwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQC9tL8nJl2UP2KZzhrZt5nYrU38VH13jxT97tJ+
UGBiudkKH7gR+nrfCVynIa5RUkAG4YaDW40wDio9dXHSSYe3J1QPI+mefDfG1y5K
m8681Sm4Qu54jFex9KKnJFS4Hvw1lIgoG8UV8ww/T+aP3rZG5GrabRshgyVxJ3c3
5EUPn8eKIt4NjDY/E2wfL0+2bgSr1CyqJbEm4njS4ent3tBLqgJ7OUYt8k76G7Pq
Or//OvKSiTZ15lfxq4BuGJ44gzSqIW+88TOL/MFz4gxIu7ejapH3N01BfFWVd79z
Wo7ixTaf+abtQLPnPEEVxg+4bC9exCs3XBT22ZVxzNxUp7CbAgMBAAGjIDAeMBwG
A1UdEQQVMBOCEWFsY2hlbXktdGVzdC0yLnVzMA0GCSqGSIb3DQEBCwUAA4IBAQCB
n8Lp7sVWs12Kuk1tV9qnb0FQggq7hnTEqlJiDefHyULqmTQaf66ls/FSVBYCRTI4
7aUy3SCm2NXho7SbN4Z3jQwBLGKGkkwnVvPl3TCpx3wCG/seIBHohBaiVmFGhYn8
OSdWNtwgCTJFg8eGDARucogO6eWzYPrsqxUiZqWkCJtZq4j6P0VQVy/N4vXhZaCk
X1lg4VE+1QFn1Hf8Zm8OBSsmPcuom1kIAvuzF4RK7ZMrrepGr5vWR1qnRKo8+UN6
D5rgoeuAd+qUQrQCMrGuyy3skqPfOzLwdx7hOi1mPpipup7XTPhhQbpJ2f5esvc5
5dMs+zd+lVW98i7Fprtj
-----END CERTIFICATE-----`;
