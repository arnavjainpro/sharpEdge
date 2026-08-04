// Optional Telegram push: active only when both env vars are set.
import { config } from "../config";

export const telegramEnabled = () => !!(config.telegramToken && config.telegramChatId);

export async function notifyTelegram(text: string) {
  if (!telegramEnabled()) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: text.slice(0, 4000),
        parse_mode: "Markdown",
      }),
    });
    if (!res.ok) console.error("[notify:telegram]", res.status, await res.text());
  } catch (err) {
    console.error("[notify:telegram] failed:", err);
  }
}
