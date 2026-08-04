// The web link flow's only stateful piece: Robinhood's login helper asks for a
// verification code synchronously, but the code arrives in a separate HTTP
// request minutes later. If this handshake breaks the UI either never shows the
// code box or hangs after the user submits: neither raises an error anywhere.
import { expect, test } from "bun:test";
import { codeAsk, submitLinkCode, type LinkState } from "./link";

test("code prompt parks in need_code and resumes with the submitted code", async () => {
  const p: LinkState = { state: "working", message: "" };
  const answer = codeAsk(p)("Enter the sms code");

  expect(p.state).toBe("need_code");
  expect(p.message).toBe("Enter the sms code");

  p.submit!("424242");
  expect(await answer).toBe("424242");
  expect(p.state).toBe("working");
  expect(p.submit).toBeUndefined(); // a second submit must not resolve anything
});

test("submitting a code with no login in flight is rejected, not swallowed", () => {
  // Drives the endpoint's 409: posting a code out of band must report failure
  // rather than silently look like it worked.
  expect(submitLinkCode(999_999, "424242")).toBe(false);
});
