import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";

const DB_DIR = join(homedir(), ".clardio");

let devMode = false;

export function setDevMode(enabled: boolean): void {
  devMode = enabled;
}

function getDbPath(): string {
  const filename = devMode ? "clardio-dev.db" : "clardio.db";
  return join(DB_DIR, filename);
}

function ensureDir(dir: string): void {
  try {
    require("fs").mkdirSync(dir, { recursive: true });
  } catch {}
}

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    ensureDir(DB_DIR);
    const dbPath = getDbPath();
    db = new Database(dbPath);
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

  db.run(`
    CREATE TABLE IF NOT EXISTS coach_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      elapsed_s REAL NOT NULL,
      user_message TEXT NOT NULL,
      response_message TEXT,
      response_power REAL,
      response_cadence REAL,
      response_note TEXT,
      latency_ms INTEGER,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    )
  `);
  // Note: response_cadence column kept for backward compat with old data.
  // New code does not write to it.

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_coach_ticks_plan_id ON coach_ticks(plan_id)
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

export type CoachTickRow = {
  id: number;
  plan_id: number;
  elapsed_s: number;
  user_message: string;
  response_message: string | null;
  response_power: number | null;
  response_cadence: number | null; // legacy, no longer written
  response_note: string | null;
  latency_ms: number | null;
};

export function saveCoachTick(
  planId: number,
  elapsedS: number,
  userMessage: string,
  response: { message: string; power: number | null; note: string | null } | null,
  latencyMs: number | null
): void {
  const db = getDb();
  db.run(
    `INSERT INTO coach_ticks (plan_id, elapsed_s, user_message, response_message, response_power, response_note, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      planId,
      elapsedS,
      userMessage,
      response?.message ?? null,
      response?.power ?? null,
      response?.note ?? null,
      latencyMs,
    ]
  );
}

export function getCoachTicks(planId: number): CoachTickRow[] {
  const db = getDb();
  return db.query(
    "SELECT * FROM coach_ticks WHERE plan_id = ? ORDER BY elapsed_s"
  ).all(planId) as CoachTickRow[];
}
