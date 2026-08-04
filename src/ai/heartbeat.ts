// Cache-warm heartbeat: re-sends the triage system prompt every 4.5 minutes
// during market hours so Anthropic's 5-minute prompt-cache TTL never lapses
// between event bursts.
//
// OFF BY DEFAULT (set CACHE_HEARTBEAT=1 to enable): prompt caching only
// engages once the prefix exceeds the model's minimum cacheable size
// (4096 tokens on Haiku 4.5 and Opus 4.8). Our current system prompts are
// well under that, so the cache markers are inert and a heartbeat would be
// pure spend. Flip this on if/when the prompts grow past the threshold
// (verify with usage.cache_read_input_tokens > 0 on a second call).
import Anthropic from "@anthropic-ai/sdk";
import { config, marketPhase, type Portfolio } from "../config";
import { triageSystemPrompt } from "./triage";
import { claudeQueue } from "./queue";

const client = new Anthropic();

export function startCacheHeartbeat(portfolio: Portfolio) {
  if (process.env.CACHE_HEARTBEAT !== "1") {
    console.log("[heartbeat] disabled (set CACHE_HEARTBEAT=1 to enable: see src/ai/heartbeat.ts)");
    return;
  }
  const beat = async () => {
    if (marketPhase() === "closed") return;
    try {
      const r = await claudeQueue(() =>
        client.messages.create({
          model: config.modelFast,
          max_tokens: 1,
          system: [
            { type: "text", text: triageSystemPrompt(portfolio), cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: "ping" }],
        })
      );
      console.log(
        `[heartbeat] cache ping: read ${r.usage.cache_read_input_tokens ?? 0}, wrote ${r.usage.cache_creation_input_tokens ?? 0} tokens`
      );
    } catch (err) {
      console.error("[heartbeat] failed:", err);
    }
  };
  setInterval(beat, 4.5 * 60_000);
  console.log("[heartbeat] cache heartbeat active (4.5 min cadence, market hours only)");
}
