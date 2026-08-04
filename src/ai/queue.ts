// Serializes Claude API calls with a minimum gap between starts, so a burst of
// detected events (e.g. a news spike across the watchlist) doesn't slam the API
// concurrently and trip rate limits. The SDK's built-in retry (2x, honors
// retry-after) still handles any 429 that gets through.
export function createThrottle(minGapMs: number) {
  let lastStart = 0;
  let chain: Promise<unknown> = Promise.resolve();

  return function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = lastStart + minGapMs - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      lastStart = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}

// One shared queue for all Claude traffic (triage + analysis + briefings),
// spaced 350ms apart: ~3 calls/sec worst case. Every Claude call already funnels
// through here, so it's the one place to record token usage (F1b): no call site
// can bypass it, and the generic throttle above stays uncoupled from Anthropic.
import { recordSpend } from "../db";

const throttle = createThrottle(350);

export function claudeQueue<T>(fn: () => Promise<T>): Promise<T> {
  return throttle(fn).then((res) => {
    // Duck-typed: only Message responses carry usage; anything else passes through.
    const r = res as any;
    if (r && typeof r === "object" && r.usage) recordSpend(String(r.model ?? "unknown"), r.usage);
    return res;
  });
}

// Every json_schema call site parses the response the same way, and every one of
// them used to blow up the same two ways when the model ran out of max_tokens
// mid-answer (adaptive thinking spends from the same budget): either the text
// block is missing entirely, or it holds half a JSON document. Both surfaced as
// a raw TypeError/SyntaxError with no hint at the cause: parse in one place and
// name it instead.
export function parseJsonResponse<T>(res: { content: any[]; stop_reason?: string | null }, label: string): T {
  const text = res.content.find((b) => b.type === "text")?.text;
  if (res.stop_reason === "max_tokens" || !text) {
    throw new Error(`${label}: response hit the token limit before the JSON was complete (stop_reason=${res.stop_reason ?? "none"}): raise max_tokens`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label}: model returned invalid JSON (${text.length} chars, stop_reason=${res.stop_reason ?? "none"})`);
  }
}
