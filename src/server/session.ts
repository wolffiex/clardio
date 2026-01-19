import type { Session } from "../shared/types";

const SESSION_TTL = 4 * 60 * 60 * 1000; // 4 hours
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

export class SessionStore {
  private sessions = new Map<string, Session>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  create(): Session {
    const id = crypto.randomUUID();
    const now = Date.now();
    const session: Session = {
      id,
      createdAt: now,
      lastSeen: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session) {
      session.lastSeen = Date.now();
    }
    return session;
  }

  getOrCreate(id: string | undefined): { session: Session; isNew: boolean } {
    if (id) {
      const existing = this.get(id);
      if (existing) {
        return { session: existing, isNew: false };
      }
    }
    return { session: this.create(), isNew: true };
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastSeen > SESSION_TTL) {
          this.sessions.delete(id);
        }
      }
    }, CLEANUP_INTERVAL);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// Global session store instance
export const sessionStore = new SessionStore();

// Cookie helpers
export function getSessionIdFromCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;

  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split("=");
    if (name === "session") {
      return value;
    }
  }
  return undefined;
}

export function createSessionCookie(id: string): string {
  return `session=${id}; HttpOnly; SameSite=Strict; Path=/`;
}
