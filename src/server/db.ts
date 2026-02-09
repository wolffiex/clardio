import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";

// Store in ~/.clardio/clardio.db
const DB_DIR = join(homedir(), ".clardio");
const DB_PATH = join(DB_DIR, "clardio.db");

function ensureDir(dir: string): void {
  try {
    require("fs").mkdirSync(dir, { recursive: true });
  } catch {}
}

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    ensureDir(DB_DIR);
    db = new Database(DB_PATH);
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA foreign_keys=ON");
    migrate(db);
  }
  return db;
}

function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      phases TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      summary TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES plans(id),
      timestamp_ms INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      power REAL,
      hr REAL,
      cadence REAL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_samples_plan_id ON samples(plan_id)
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export type PlanRow = {
  id: number;
  created_at: string;
  phases: string;  // JSON string
  completed: number;
  summary: string | null;
};

export function savePlan(phasesJson: string): number {
  const db = getDb();
  const result = db.run("INSERT INTO plans (phases) VALUES (?)", [phasesJson]);
  return Number(result.lastInsertRowid);
}

export function getRecentPlans(limit: number = 10): PlanRow[] {
  const db = getDb();
  return db.query("SELECT * FROM plans ORDER BY created_at DESC LIMIT ?").all(limit) as PlanRow[];
}

export function completePlan(id: number, summary: string): void {
  const db = getDb();
  db.run("UPDATE plans SET completed = 1, summary = ? WHERE id = ?", [summary, id]);
}

export function saveSample(
  planId: number,
  timestampMs: number,
  durationMs: number,
  power: number | null,
  hr: number | null,
  cadence: number | null
): void {
  const db = getDb();
  db.run(
    "INSERT INTO samples (plan_id, timestamp_ms, duration_ms, power, hr, cadence) VALUES (?, ?, ?, ?, ?, ?)",
    [planId, timestampMs, durationMs, power, hr, cadence]
  );
}

export function getSamplesForPlan(planId: number): Array<{
  timestamp_ms: number;
  duration_ms: number;
  power: number | null;
  hr: number | null;
  cadence: number | null;
}> {
  const db = getDb();
  return db.query(
    "SELECT timestamp_ms, duration_ms, power, hr, cadence FROM samples WHERE plan_id = ? ORDER BY timestamp_ms"
  ).all(planId) as any[];
}
