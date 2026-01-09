# Clardio Code Review

**Date:** 2025-01-09
**Reviewer:** Claude

## Executive Summary

The codebase is well-structured and relatively clean for its size. The main opportunities are around DRY improvements in route handlers, removing redundant broadcast functions in SSE, consolidating duplicate time formatting functions, and reducing excessive validation tests.

---

## Issues Found

### HIGH PRIORITY

#### 1. Route Handler Boilerplate Duplication
**Files:** `src/server/routes.ts` (lines 21-227)

All four route handlers (`handleCoach`, `handleMetrics`, `handleTarget`, `handleEnd`) repeat the same pattern:
- Method check (POST only)
- Empty body check
- JSON parsing with try/catch
- Validation
- Response formatting

**Suggested Fix:** Extract a `handlePostRoute<T>` helper:
```typescript
async function handlePostRoute<T>(
  req: Request,
  validator: (body: unknown) => body is T,
  validationError: string,
  handler: (body: T) => void
): Promise<Response>
```
This could reduce ~200 lines to ~80 lines.

**Type:** Larger refactor

---

#### 2. Duplicate `formatRemaining` Function
**Files:**
- `src/client/handlers.ts` (lines 27-31)
- `src/client/countdown.ts` (lines 6-10)

Identical function defined in two places.

**Suggested Fix:** Remove from `handlers.ts`, import from `countdown.ts`, or create a shared `src/client/format.ts` module.

**Type:** Quick win

---

#### 3. Redundant Typed Broadcast Functions in SSE
**File:** `src/server/sse.ts` (lines 64-86)

Five typed broadcast functions exist (`broadcastCoach`, `broadcastMetrics`, `broadcastTarget`, `broadcastSetTarget`, `broadcastWorkoutEnd`) but they're never used - only the generic `broadcast()` is called from routes.

**Suggested Fix:** Remove the unused typed broadcast functions. The generic `broadcast(eventType, data)` is sufficient and is already type-checked via `SSEEventType`.

**Exports in `src/server/index.ts` (line 63):**
```typescript
export { broadcast, broadcastCoach, broadcastMetrics, broadcastTarget, broadcastSetTarget, broadcastWorkoutEnd };
```
These typed exports should also be removed if unused externally.

**Type:** Quick win

---

### MEDIUM PRIORITY

#### 4. Magic Number: Rolling Average Window
**File:** `src/client/ui.ts` (lines 58-59)
```typescript
this.powerAvg = new RollingAverage(3);
this.cadenceAvg = new RollingAverage(3);
```

The window size `3` is hardcoded without explanation.

**Suggested Fix:** Extract to constant:
```typescript
const ROLLING_AVERAGE_WINDOW_SECONDS = 3;
```

**Type:** Quick win

---

#### 5. Magic Number: SSE Max Listeners
**File:** `src/server/sse.ts` (line 6)
```typescript
emitter.setMaxListeners(100); // Support multiple connections
```

Comment is good but 100 should be a named constant.

**Suggested Fix:**
```typescript
const MAX_SSE_CONNECTIONS = 100;
```

**Type:** Quick win

---

#### 6. Power/Cadence Progress Bar Handling is Repetitive
**File:** `src/client/ui.ts` (lines 141-155)

The `updateProgressBar` method selects elements based on type string:
```typescript
const elements = type === 'power'
  ? { targetSection: this.elements.powerTargetSection, ... }
  : { targetSection: this.elements.cadenceTargetSection, ... };
```

**Suggested Fix:** Store elements in a structure indexed by type:
```typescript
private meterElements: Record<'power' | 'cadence', MeterElements>;
```
Then access with `this.meterElements[type]`.

**Type:** Medium refactor

---

#### 7. Unused `SetTargetPayload` Import
**File:** `src/server/sse.ts` (line 3)
```typescript
import type { ..., SetTargetPayload, ... } from "../shared/types";
```

`SetTargetPayload` is imported but only used in the unused `broadcastSetTarget` function.

**Suggested Fix:** Remove import when removing unused broadcast functions.

**Type:** Quick win (part of issue #3)

---

#### 8. `formatTargetDisplay` in handlers.ts is Unused
**File:** `src/client/handlers.ts` (lines 38-52)

This function is tested but doesn't appear to be used in the actual client code. The `CountdownTimer` uses `formatTargetText` from `countdown.ts` instead.

**Suggested Fix:** Verify if needed. If not, remove function and its tests.

**Type:** Quick win

---

#### 9. Inconsistent Time Formatting Functions
**Files:**
- `formatTime` in `handlers.ts` - Returns `MM:SS` or `H:MM:SS` format
- `formatRemaining` in `countdown.ts` - Returns `M:SS` format

The `formatTime` pads minutes to 2 digits (`02:05`), but `formatRemaining` doesn't (`2:47`). This is intentional for display purposes but could be confusing.

**Suggested Fix:** Add comments explaining the different formats, or consider consolidating with a format option parameter.

**Type:** Low priority / documentation

---

### LOW PRIORITY

#### 10. `parseSSEEvent` is Just `JSON.parse`
**File:** `src/client/handlers.ts` (lines 6-8)
```typescript
export function parseSSEEvent<T>(data: string): T {
  return JSON.parse(data);
}
```

This wrapper adds no value over direct `JSON.parse` call.

**Suggested Fix:** Remove and use `JSON.parse` directly, or add actual value (error handling, validation).

**Type:** Quick win

---

#### 11. UIController Testing Methods Could Use Visibility Modifier
**File:** `src/client/ui.ts` (lines 277-296)

Methods `getCurrentTarget()`, `getBaseline()`, `getActiveTarget()` are marked as "for testing" but are public.

**Suggested Fix:** Either accept they're public API, or if TypeScript supports it, use a testing-only export pattern.

**Type:** Low priority / style

---

#### 12. Unused `TargetEvent` Import in handlers.ts
**File:** `src/client/handlers.ts` (line 1)

`TargetEvent` is imported and used, but `parseSSEEvent` which returns it isn't actually used in the app (SSE client parses JSON directly).

**Suggested Fix:** Verify usage; likely fine as-is since it's tested.

**Type:** No action needed

---

## Test Review

### Tests That Could Be Consolidated

#### 1. Excessive Validation Tests for Each Field Type
**File:** `tests/tool-endpoints.test.ts`

For `/api/metrics`, there are 10 tests for various validation scenarios. Many are near-identical:
- "rejects payload with non-number power"
- "rejects payload with non-number hr"
- "rejects payload with non-number cadence"
- "rejects payload with non-number elapsed"

**Suggested Fix:** Use parameterized tests:
```typescript
test.each([
  ['power', { hr: 145, cadence: 90, elapsed: 300 }],
  ['hr', { power: 200, cadence: 90, elapsed: 300 }],
  // ...
])('rejects payload with missing %s', async (field, payload) => {
  // single test body
});
```

**Impact:** Could reduce ~40 tests to ~10 parameterized tests

---

#### 2. Similar Endpoint Tests Follow Same Pattern
**File:** `tests/tool-endpoints.test.ts`

Each endpoint (coach, target, metrics, end) has:
- Valid payload test
- Missing required fields tests
- Invalid type tests
- Empty body test
- Invalid JSON test
- Wrong method test

**Suggested Fix:** Create shared test helpers:
```typescript
function testEndpointValidation(
  endpoint: string,
  validPayload: object,
  requiredFields: string[]
) { ... }
```

---

#### 3. `parseSSEEvent` Tests Are Trivial
**File:** `tests/client.test.ts` (lines 13-54)

Testing that `JSON.parse` works is not valuable:
```typescript
test("parses coach event", () => {
  const data = '{"text":"Hello rider"}';
  const result = parseSSEEvent<CoachEvent>(data);
  expect(result.text).toBe("Hello rider");
});
```

**Suggested Fix:** Remove these tests, or if `parseSSEEvent` is removed, tests go with it.

---

#### 4. Test Setup Duplication
**Files:** `tests/server.test.ts`, `tests/tool-endpoints.test.ts`

Both files have nearly identical beforeAll/afterAll setup:
```typescript
let server: Server;
let baseUrl: string;
beforeAll(async () => {
  const mod = await import("../src/server/index");
  server = mod.createServer();
  baseUrl = `http://localhost:${server.port}`;
});
afterAll(() => {
  server?.stop();
});
```

**Suggested Fix:** Create `tests/setup.ts` with shared server setup:
```typescript
export function setupTestServer() { ... }
```

---

### Tests That Are Actually Good

- `CountdownTimer` tests are thorough and test actual behavior
- `RollingAverage` tests are appropriate
- `calculateFillPercent` and `getProgressColor` tests are simple but valuable
- SSE connection tests verify actual streaming behavior

### Missing Tests

1. **No tests for UIController DOM interactions** - Would require DOM mocking
2. **No tests for SSEClient.connect()** - Would require EventSource mocking
3. **No integration tests** - End-to-end flow from POST to SSE broadcast to client

---

## Types Review

**File:** `src/shared/types.ts`

### Observations

1. **Well-organized** - Types are logically grouped with comments
2. **No obvious redundancy** - Each type serves a purpose
3. **`SSEMessage<T>` may be unused** - Grep for usage in codebase

### Potential Simplification

The `SetTargetPayload` vs `TargetEvent` distinction is subtle:
- `SetTargetPayload`: has `duration` (what coach sends)
- `TargetEvent`: has `remaining` (what UI receives)

This is documented well but could be a single type with both fields optional:
```typescript
interface Target {
  power: number;
  cadence: number;
  duration?: number;   // Coach sets this
  remaining?: number;  // Server converts to this for countdown
}
```

**Recommendation:** Keep as-is; the separation makes the API contract clearer.

---

## HTML/CSS Review

**File:** `public/index.html`

### Good

- Clean structure
- Good use of Tailwind utility classes
- Proper safe-area handling for iPad
- No inline styles except for custom CSS that can't be Tailwind

### Observations

1. **CDN Tailwind** - Using CDN version (`cdn.tailwindcss.com`). Fine for development but should use build version for production.

2. **Repeated Tailwind patterns** - Power and cadence meters have identical class structures:
```html
<div class="flex justify-between items-end mb-3">
<div class="relative h-8 bg-gray-900 rounded-full overflow-hidden hidden">
```
This is acceptable for HTML; extracting to components would require a framework.

3. **PiP placeholder has no visual indication** - The div at lines 115-117 is invisible and may confuse users. Consider adding a subtle indicator or comment.

4. **Unused elements** - `#power-unit` and `#cadence-unit` span IDs are defined but never referenced in JS.

---

## General Observations

### Dead Code

1. Typed broadcast functions in `sse.ts` (see issue #3)
2. Possibly `formatTargetDisplay` in `handlers.ts` (see issue #8)
3. Possibly `parseSSEEvent` if not used (see issue #10)

### Unused Imports

1. `SetTargetPayload` in `sse.ts` (tied to unused function)

### Inconsistent Naming

None found - naming is consistent throughout.

### Overly Complex Functions

None found - functions are appropriately sized.

---

## Prioritized Action Items

### Quick Wins (< 30 min each)
1. Remove duplicate `formatRemaining` function
2. Remove unused typed broadcast functions from `sse.ts`
3. Extract magic numbers to constants (rolling average window, max SSE connections)
4. Remove trivial `parseSSEEvent` wrapper and its tests
5. Verify and remove `formatTargetDisplay` if unused

### Medium Refactors (1-2 hours each)
1. Create shared test server setup
2. Parameterize validation tests
3. Index meter elements by type in UIController

### Larger Refactors (half day+)
1. Extract route handler boilerplate to helper function
2. Add DOM testing for UIController (requires jsdom setup)
3. Add integration tests

---

## Summary

The codebase is in good shape. Main themes:
- **DRY violations** are mostly in test code and route handlers
- **Dead code** exists but is minimal
- **Tests** are thorough but could be more concise with parameterization
- **Types** are well-designed
- **HTML/CSS** is clean

Total estimated cleanup effort: 4-8 hours for all items
