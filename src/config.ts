// All configuration comes from environment variables, validated once at boot.
// Defaults are for local development only; deployments override them via .env / compose.
import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("mysql://app:app-password@127.0.0.1:3306/seats"),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(20),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters")
    .default("local-dev-jwt-secret-change-me-0123456789"),
  ADMIN_API_KEY: z.string().min(8).default("local-dev-admin-key"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);
