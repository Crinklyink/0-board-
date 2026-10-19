import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log } from './util.js';

/**
 * Schema notes
 * - WAL + synchronous=FULL: a power cut can lose at most the transaction in flight, never corrupt the file.
 * - Every canvas change is an immutable row in `ops` with before/after JSON. That log powers sync catch-up,
 *   undo of AI batches, and "what changed" history.
 * - `objects.rid` is an explicit INTEGER PRIMARY KEY so FTS rowids stay stable across VACUUM.
 */
const MIGRATIONS = [
  `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE boards(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('thoughts','space')),
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL DEFAULT 0,
    camera TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    opened_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE objects(
    rid INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(board_id, id)
  );

  CREATE TABLE ops(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    obj_id TEXT NOT NULL,
    before TEXT,
    after TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX ops_board_seq ON ops(board_id, seq);
  CREATE INDEX ops_batch ON ops(batch_id);

  CREATE TABLE batches(
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    label TEXT,
    turn_id TEXT,
    ts INTEGER NOT NULL,
    first_seq INTEGER,
    last_seq INTEGER,
    undone INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX batches_board_ts ON batches(board_id, ts);

  CREATE TABLE snapshots(
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    label TEXT,
    n INTEGER NOT NULL,
    data BLOB NOT NULL
  );
  CREATE INDEX snapshots_board_ts ON snapshots(board_id, ts);

  CREATE TABLE assets(
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    filename TEXT,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    caption TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX assets_sha ON assets(sha256);

  CREATE TABLE messages(
    rid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    board_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT,
    attachments TEXT,
    turn_id TEXT,
    meta TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX messages_board_ts ON messages(board_id, ts);

  CREATE TABLE devices(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0
  );

  CREATE VIRTUAL TABLE fts_obj USING fts5(body, tokenize='porter unicode61');
  CREATE VIRTUAL TABLE fts_msg USING fts5(body, tokenize='porter unicode61');
  `,
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'oboard.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA wal_autocheckpoint = 400');

  const check = db.prepare('PRAGMA quick_check').get();
  const verdict = check && Object.values(check)[0];
  if (verdict !== 'ok') {
    log('error', 'database failed quick_check; restore from a backup (scripts/restore.sh)', { verdict });
    throw new Error(`database integrity check failed: ${verdict}`);
  }

  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    log('info', 'applied migration', { version: v + 1 });
  }
  return { db, file };
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT, rolling back on throw. Re-entrant for nested calls. */
export function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}
