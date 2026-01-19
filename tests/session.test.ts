import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore, getSessionIdFromCookie, createSessionCookie } from "../src/server/session";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  afterEach(() => {
    store.stop();
  });

  test("create() generates a new session with UUID", () => {
    const session = store.create();

    expect(session.id).toBeDefined();
    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.lastSeen).toBeGreaterThan(0);
  });

  test("get() retrieves existing session and updates lastSeen", async () => {
    const session = store.create();
    const originalLastSeen = session.lastSeen;

    // Small delay to ensure lastSeen changes
    await new Promise(r => setTimeout(r, 10));

    const retrieved = store.get(session.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(session.id);
    expect(retrieved!.lastSeen).toBeGreaterThanOrEqual(originalLastSeen);
  });

  test("get() returns undefined for non-existent session", () => {
    const retrieved = store.get("non-existent-id");
    expect(retrieved).toBeUndefined();
  });

  test("getOrCreate() returns existing session if ID matches", () => {
    const session = store.create();
    const { session: retrieved, isNew } = store.getOrCreate(session.id);

    expect(isNew).toBe(false);
    expect(retrieved.id).toBe(session.id);
  });

  test("getOrCreate() creates new session if ID is undefined", () => {
    const { session, isNew } = store.getOrCreate(undefined);

    expect(isNew).toBe(true);
    expect(session.id).toBeDefined();
  });

  test("getOrCreate() creates new session if ID doesn't exist", () => {
    const { session, isNew } = store.getOrCreate("non-existent-id");

    expect(isNew).toBe(true);
    expect(session.id).not.toBe("non-existent-id");
  });

  test("delete() removes a session", () => {
    const session = store.create();
    expect(store.has(session.id)).toBe(true);

    const deleted = store.delete(session.id);

    expect(deleted).toBe(true);
    expect(store.has(session.id)).toBe(false);
  });

  test("has() returns true for existing session", () => {
    const session = store.create();
    expect(store.has(session.id)).toBe(true);
  });

  test("has() returns false for non-existent session", () => {
    expect(store.has("non-existent-id")).toBe(false);
  });
});

describe("Cookie helpers", () => {
  test("getSessionIdFromCookie() extracts session ID from cookie header", () => {
    const sessionId = getSessionIdFromCookie("session=abc123; other=value");
    expect(sessionId).toBe("abc123");
  });

  test("getSessionIdFromCookie() returns undefined for missing session cookie", () => {
    const sessionId = getSessionIdFromCookie("other=value");
    expect(sessionId).toBeUndefined();
  });

  test("getSessionIdFromCookie() returns undefined for null header", () => {
    const sessionId = getSessionIdFromCookie(null);
    expect(sessionId).toBeUndefined();
  });

  test("getSessionIdFromCookie() handles session as only cookie", () => {
    const sessionId = getSessionIdFromCookie("session=xyz789");
    expect(sessionId).toBe("xyz789");
  });

  test("createSessionCookie() creates correct cookie string", () => {
    const cookie = createSessionCookie("test-session-id");
    expect(cookie).toBe("session=test-session-id; HttpOnly; SameSite=Strict; Path=/");
  });
});
