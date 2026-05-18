import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// For Vercel serverless, use a single connection with no keep-alive
// In production, Neon handles connection pooling via pgbouncer
const connectionString = process.env.DATABASE_URL;

const queryClient = postgres(connectionString, {
  max: 1, // Serverless: one connection per function invocation
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });

export type Db = typeof db;
