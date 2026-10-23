/// <reference types="node" />
import { defineConfig } from "drizzle-kit";

/**
 * The connection string is read from the environment — never hardcoded.
 *
 * This file previously embedded a live Supabase password in source. Any
 * credential that has been committed must be treated as compromised and
 * rotated in the Supabase dashboard (Project settings → Database → Reset
 * database password), then supplied through DATABASE_URL.
 *
 * Load it from `.env.local` / `.env` or export it in the shell before running
 * `pnpm run db:push`. Point it only at the database you intend to migrate.
 */
if (typeof process.loadEnvFile === "function") {
  for (const file of [".env.local", ".env", "../../.env.local", "../../.env"]) {
    try {
      // Never overrides a variable already present in the environment.
      process.loadEnvFile(file);
    } catch {
      // Missing or unreadable file: the shell may already carry the value.
    }
  }
}

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL must be set before running drizzle-kit. " +
      "Export it in the shell or put it in .env.local at the repository root.",
  );
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: { url },
});
