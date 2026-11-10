import { Directories } from "@distilled.cloud/acme";

/**
 * An ACME certificate authority: its directory URL plus, for private CAs
 * (Pebble, step-ca), the PEM root that signs the CA's own HTTPS endpoint.
 */
export interface CertificateAuthority {
  /** The CA's ACME directory URL. */
  readonly directoryUrl: string;
  /**
   * PEM root certificate to trust for the CA's HTTPS endpoint. Only for
   * private CAs whose API certificate is not publicly trusted; public CAs
   * leave it unset.
   */
  readonly trustedRoot?: string | undefined;
}

/** Let's Encrypt production. No External Account Binding. */
export const LetsEncrypt: CertificateAuthority = {
  directoryUrl: Directories.LetsEncrypt,
};

/** Let's Encrypt staging: generous limits, untrusted chain. */
export const LetsEncryptStaging: CertificateAuthority = {
  directoryUrl: Directories.LetsEncryptStaging,
};

/** ZeroSSL. Requires an External Account Binding (`eab`). */
export const ZeroSSL: CertificateAuthority = {
  directoryUrl: Directories.ZeroSSL,
};

/** Google Trust Services. Requires an External Account Binding (`eab`). */
export const GoogleTrustServices: CertificateAuthority = {
  directoryUrl: Directories.GoogleTrustServices,
};

/** Google Trust Services staging. */
export const GoogleTrustServicesStaging: CertificateAuthority = {
  directoryUrl: Directories.GoogleTrustServicesStaging,
};
