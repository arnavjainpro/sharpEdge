import { describe, expect, test } from "bun:test";

describe("dashboard shell", () => {
  test("all inline scripts parse", async () => {
    const html = await Bun.file(new URL("./index.html", import.meta.url)).text();
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];

    expect(scripts.length).toBeGreaterThan(0);
    for (const [, source] of scripts) {
      if (source.trim()) expect(() => new Function(source)).not.toThrow();
    }
  });

  test("startup listeners reference elements in the shell", async () => {
    const html = await Bun.file(new URL("./index.html", import.meta.url)).text();
    const ids = new Set([...html.matchAll(/\bid=["'`]([^"'`]+)["'`]/g)].map((match) => match[1]));
    const listenerIds = [...html.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)\.addEventListener/g)]
      .map((match) => match[1]);

    expect([...new Set(listenerIds.filter((id) => !ids.has(id)))]).toEqual([]);
  });
});
