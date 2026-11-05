import * as vault from "@distilled.cloud/gcp/vault_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

// Vault needs a Workspace customer with Vault licenses; the testing
// service account gets Forbidden "Request had insufficient authentication
// scopes." Set GCP_TEST_VAULT=1 (and GCP_TEST_VAULT_ACCOUNT) on one.
export const runLifecycle = !process.env.FAST && !!process.env.GCP_TEST_VAULT;

export const vaultAccount = process.env.GCP_TEST_VAULT_ACCOUNT?.trim();

export const runAccountLifecycle = runLifecycle && !!vaultAccount;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const sampleMailQuery = (email: string): vault.Query => ({
  corpus: "MAIL",
  dataScope: "ALL_DATA",
  searchMethod: "ACCOUNT",
  accountInfo: { emails: [email] },
  terms: "subject:alchemy",
  timeZone: "America/Los_Angeles",
});

export const sampleMailExportOptions = (): vault.ExportOptions => ({
  mailOptions: { exportFormat: "MBOX" },
});
