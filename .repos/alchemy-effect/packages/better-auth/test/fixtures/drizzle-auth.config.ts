import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/bun-sqlite";

export const auth = betterAuth({
  secret: "test-secret-test-secret-test-secret",
  emailAndPassword: { enabled: true },
  database: drizzleAdapter(drizzle(":memory:"), { provider: "sqlite" }),
});
