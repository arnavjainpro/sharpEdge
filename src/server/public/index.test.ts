import { describe, expect, test } from "bun:test";
import { relative } from "path";
import { fileURLToPath } from "url";

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

  test("runtime copy contains no em dashes", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const emDash = String.fromCodePoint(0x2014);
    const offenders: string[] = [];

    for (const dir of ["src", "scripts", "config"]) {
      const glob = new Bun.Glob("**/*.{ts,html,yaml,sql}");
      for await (const file of glob.scan({ cwd: `${root}/${dir}`, absolute: true, onlyFiles: true })) {
        // Local portfolio.yaml is private, gitignored user data rather than app
        // copy. The committed portfolio.example.yaml is still checked.
        if (relative(root, file) === "config/portfolio.yaml") continue;
        const text = await Bun.file(file).text();
        if (text.includes(emDash)) offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
