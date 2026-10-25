import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const migrationsDir = new URL('./migrations/', import.meta.url);

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('begin');
  try {
    const result = fn();
    db.exec('commit');
    return result;
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}

export function now(): string {
  return new Date().toISOString();
}

function migrate(db: Db): void {
  db.exec('create table if not exists schema_migrations (version text primary key, applied_at text not null)');
  const applied = new Set(
    db.prepare('select version from schema_migrations').all().map((row) => String(row.version)),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(new URL(file, migrationsDir), 'utf8');
    transaction(db, () => {
      db.exec(sql);
      db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(file, now());
    });
  }
}
