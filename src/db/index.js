// Database layer.
//
// Production target is PostgreSQL. For zero-infra local runs we use Node's
// built-in SQLite (node:sqlite). To keep the application code identical across
// both, every module talks to this thin adapter exposing:
//
//   db.query(sql, params)   -> { rows }
//   db.get(sql, params)     -> row | undefined
//   db.run(sql, params)     -> { changes }
//   db.tx(fn)               -> runs fn inside a transaction (atomic)
//
// The SQL we write is the intersection that works on both engines. Where Postgres
// would use $1,$2 placeholders, we use ? here and the Postgres adapter (not needed
// for the MVP) would translate. Money correctness relies on db.tx wrapping all
// ledger writes.

import { DatabaseSync } from 'node:sqlite';
import { config } from '../config/index.js';

let sqlite;

function init() {
  if (sqlite) return sqlite;
  sqlite = new DatabaseSync(config.sqlitePath);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  return sqlite;
}

export const db = {
  raw() {
    return init();
  },

  query(sql, params = []) {
    const stmt = init().prepare(sql);
    const rows = stmt.all(...params);
    return { rows };
  },

  get(sql, params = []) {
    const stmt = init().prepare(sql);
    return stmt.get(...params);
  },

  run(sql, params = []) {
    const stmt = init().prepare(sql);
    const info = stmt.run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  },

  // Atomic transaction. Throws roll back. Critical for ledger integrity.
  tx(fn) {
    const conn = init();
    conn.exec('BEGIN');
    try {
      const result = fn();
      conn.exec('COMMIT');
      return result;
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
  },
};
