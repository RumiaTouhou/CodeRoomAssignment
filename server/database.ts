import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class StorageError extends Error {
  constructor() { super("Durable storage is temporarily unavailable."); this.name = "StorageError"; }
}

export class Database {
  private readonly database: DatabaseSync;
  readonly persistent: boolean;

  constructor(file = ":memory:") {
    this.persistent = file !== ":memory:";
    if (this.persistent) mkdirSync(dirname(resolve(file)), { recursive: true });
    this.database = new DatabaseSync(file);
    try {
      this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
      if (this.persistent) this.database.exec("PRAGMA journal_mode = WAL;");
      const schema = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
      if (schema.user_version > 1) throw new Error("The database schema is newer than this application supports.");
      this.database.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS application_state (name TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1; COMMIT;");
    } catch (error) { this.database.close(); throw error; }
  }

  read<T>(name: string): T | undefined {
    const row = this.database.prepare("SELECT value FROM application_state WHERE name = ?").get(name) as { value: string } | undefined;
    if (!row) return undefined;
    if (Buffer.byteLength(row.value) > 48 * 1024 * 1024) throw new Error("Stored state exceeds the supported capacity.");
    return JSON.parse(row.value) as T;
  }

  write(name: string, value: unknown): void {
    this.writeMany([[name, value]]);
  }

  writeMany(entries: readonly (readonly [string, unknown])[]): void {
    try {
      const serialized = entries.map(([name, value]) => {
        const text = JSON.stringify(value);
        if (Buffer.byteLength(text) > 48 * 1024 * 1024) throw new StorageError();
        return [name, text] as const;
      });
      this.database.exec("BEGIN IMMEDIATE");
      const statement = this.database.prepare("INSERT INTO application_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value");
      for (const [name, text] of serialized) statement.run(name, text);
      this.database.exec("COMMIT");
    } catch {
      try { this.database.exec("ROLLBACK"); } catch { /* A failed begin has no transaction to roll back. */ }
      throw new StorageError();
    }
  }

  close(): void {
    try { if (this.persistent) this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
    finally { this.database.close(); }
  }
}
