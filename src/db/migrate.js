// Applies the schema. For the MVP (SQLite) we load schema.sqlite.sql.
// In production this would run the numbered migrations in /migrations against Postgres.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function migrate() {
  const schema = readFileSync(join(__dirname, 'schema.sqlite.sql'), 'utf8');
  db.raw().exec(schema);
  // Additional feature tables (kept in separate files for clarity).
  try {
    const checkout = readFileSync(join(__dirname, 'schema.checkout.sql'), 'utf8');
    db.raw().exec(checkout);
  } catch {
    /* optional */
  }
}

// Run directly: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
  console.log('✓ migrations applied');
}
