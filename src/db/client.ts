import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalDb = globalThis as typeof globalThis & {
  postgresClient?: Sql;
};

const parsedPoolMax = Number(process.env.POSTGRES_MAX_CONNECTIONS);
const poolMax = Number.isFinite(parsedPoolMax)
  ? Math.max(1, parsedPoolMax)
  : process.env.NODE_ENV === "development"
    ? 1
    : 5;

const createClient = () =>
  postgres(databaseUrl, {
    prepare: false,
    connect_timeout: 15,
    max: poolMax,
  });

const client = globalDb.postgresClient ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalDb.postgresClient = client;
}

export const db = drizzle({ client, schema });
