import { expect, test, afterAll } from "bun:test";
import {
  db, createChatThread, listChatThreads, chatThread, chatMessages,
  appendChatMessage, deleteChatThread, chatTitleFrom,
} from "../db";
import { createUser, hashPassword } from "../auth";
import { replayWindow, CHAT_REPLAY_TURNS, CHAT_REPLAY_MAX_AGE_SEC } from "../ai/advisor";

// Saved advisor conversations. The database half is exercised against the real
// configured database with throwaway accounts; the replay window is pure and
// runs without one.
//
// NOTE: writes to the configured database, using throwaway @example.invalid
// accounts that are deleted afterwards.

const made: number[] = [];
async function throwawayUser(): Promise<number> {
  const id = await createUser(`chat-test-${crypto.randomUUID()}@example.invalid`, await hashPassword("x"));
  made.push(id);
  return id;
}

// chat_threads and chat_messages both cascade from users, so deleting the
// account is enough. That is the property the reset script depends on, and
// the cascade test below is what proves it rather than assuming it.
afterAll(async () => {
  for (const id of made) await db.query(`DELETE FROM users WHERE id = ?`).run(id);
});

// ── replay window (pure) ────────────────────────────────────────────────────

const turn = (ts: number, role: "user" | "assistant", content: string) => ({ ts, role, content });
const NOW = 1_800_000_000;

test("replay keeps only the most recent turns", () => {
  const msgs = Array.from({ length: 20 }, (_, i) =>
    turn(NOW - 60, i % 2 === 0 ? "user" : "assistant", `m${i}`)
  );
  const out = replayWindow(msgs, NOW);
  expect(out).toHaveLength(CHAT_REPLAY_TURNS);
  expect(out.at(-1)!.content).toBe("m19");
});

test("replay drops turns older than the age cut", () => {
  const stale = CHAT_REPLAY_MAX_AGE_SEC + 60;
  const out = replayWindow([
    turn(NOW - stale, "user", "should I sell HPE?"),
    turn(NOW - stale, "assistant", "hold HPE, stop at 19.40"),
    turn(NOW - 30, "user", "what about NVDA?"),
    turn(NOW - 20, "assistant", "fresh answer"),
  ], NOW);
  // The three-week-old stop price is the exact thing that must not replay into
  // today's context as current fact.
  expect(out.map((t) => t.content)).toEqual(["what about NVDA?", "fresh answer"]);
});

test("replay drops a trailing question that was never answered", () => {
  const out = replayWindow([
    turn(NOW - 60, "user", "q1"),
    turn(NOW - 59, "assistant", "a1"),
    turn(NOW - 10, "user", "q2 that failed"),
  ], NOW);
  expect(out.map((t) => t.content)).toEqual(["q1", "a1"]);
});

test("replay of an empty or all-stale thread is empty, not undefined", () => {
  expect(replayWindow([], NOW)).toEqual([]);
  expect(replayWindow([turn(NOW - 999_999, "user", "old")], NOW)).toEqual([]);
});

// ── titles ──────────────────────────────────────────────────────────────────

test("a title collapses whitespace and truncates long questions", () => {
  expect(chatTitleFrom("  should I   sell\nHPE?  ")).toBe("should I sell HPE?");
  const long = chatTitleFrom("x".repeat(200));
  expect(long).toHaveLength(60);
  expect(long.endsWith("…")).toBe(true);
});

// ── threads (real database) ─────────────────────────────────────────────────

test("a thread round-trips with its messages in order", async () => {
  const a = await throwawayUser();
  const id = await createChatThread(a, chatTitleFrom("should I sell HPE?"));
  await appendChatMessage(a, id, "user", "should I sell HPE?");
  await appendChatMessage(a, id, "assistant", "Not yet.");

  const threads = await listChatThreads(a);
  expect(threads).toHaveLength(1);
  expect(threads[0]!.title).toBe("should I sell HPE?");

  const msgs = await chatMessages(a, id);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(msgs[1]!.content).toBe("Not yet.");
});

test("a thread is invisible to every other account", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  const id = await createChatThread(a, "A's private conversation");
  await appendChatMessage(a, id, "user", "how big is my NVDA position?");

  // Reading, listing and deleting all have to be scoped, not just reading:
  // a 403 on delete would still confirm the thread exists.
  expect(await chatThread(b, id)).toBeNull();
  expect(await chatMessages(b, id)).toHaveLength(0);
  expect(await listChatThreads(b)).toHaveLength(0);
  expect(await deleteChatThread(b, id)).toBe(false);
  // Still intact for its owner after B's attempt.
  expect(await chatMessages(a, id)).toHaveLength(1);
});

test("deleting a thread takes its messages with it", async () => {
  const a = await throwawayUser();
  const id = await createChatThread(a, "throwaway");
  await appendChatMessage(a, id, "user", "q");
  await appendChatMessage(a, id, "assistant", "a");

  expect(await deleteChatThread(a, id)).toBe(true);
  expect(await deleteChatThread(a, id)).toBe(false); // second delete is a 404, not an error
  const left = await db.query(`SELECT count(*)::int n FROM chat_messages WHERE thread_id = ?`).get(id) as { n: number };
  expect(left.n).toBe(0);
});

test("an unknown role is refused by the database, not stored", async () => {
  const a = await throwawayUser();
  const id = await createChatThread(a, "t");
  // A bad role would not surface here — it would surface as an Anthropic 400
  // the next time the thread was replayed, far from the write that caused it.
  let refused = false;
  try {
    await db.query(
      `INSERT INTO chat_messages (thread_id, user_id, ts, role, content) VALUES (?, ?, 1, 'system', 'x')`
    ).run(id, a);
  } catch { refused = true; }
  expect(refused).toBe(true);
});

test("deleting the account deletes its threads, so reset-accounts.ts still works", async () => {
  const a = await throwawayUser();
  const id = await createChatThread(a, "t");
  await appendChatMessage(a, id, "user", "q");

  // This is the exact shape of scripts/reset-accounts.ts and of the afterAll
  // in every real-database test: delete the user while owned rows still exist.
  // Without ON DELETE CASCADE the foreign key refuses and takes the whole
  // reset transaction down with it.
  await db.query(`DELETE FROM users WHERE id = ?`).run(a);
  const orphans = await db.query(`SELECT count(*)::int n FROM chat_messages WHERE user_id = ?`).get(a) as { n: number };
  expect(orphans.n).toBe(0);
});
