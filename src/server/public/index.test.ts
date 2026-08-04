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

  test("dashboard and landing page expose accessibility foundations", async () => {
    for (const page of ["index.html", "landing.html"]) {
      const html = await Bun.file(new URL(`./${page}`, import.meta.url)).text();

      expect(html).toContain("viewport-fit=cover");
      expect(html).toMatch(/class="skip-link"[^>]*href="#main-content"/);
      expect(html).toMatch(/<main[^>]*id="main-content"[^>]*tabindex="-1"/);
      expect(html).toContain("@media (prefers-reduced-motion: reduce)");
      expect(html).toContain("@media (forced-colors: active)");
    }
  });

  test("custom dashboard interactions have keyboard and screen reader semantics", async () => {
    const html = await Bun.file(new URL("./index.html", import.meta.url)).text();

    expect(html).toMatch(/id="ticker-modal" role="dialog" aria-modal="true" aria-labelledby=/);
    expect(html).toMatch(/id="drop-zone" tabindex="0" role="button"/);
    expect(html).toMatch(/id="bt-drop" tabindex="0" role="button"/);
    expect(html).toMatch(/class="swing-slot"[^>]*role="button"[^>]*tabindex="0"/);
    expect(html).toMatch(/id="auth-error" role="alert" aria-live="assertive"/);
    expect(html).toContain('role="link" tabindex="0" aria-label="Open ${esc(t)} stock details"');
    expect(html).toContain('e.key === "Enter" || e.key === " "');
  });
});
