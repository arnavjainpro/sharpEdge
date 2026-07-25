// Cookie parsing + session resolution for server.ts's flat route handler.
import { validateSession } from "./index";

const COOKIE_NAME = "mp_session";
const MAX_AGE_SEC = 30 * 24 * 3600;

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function userIdFromRequest(req: Request): Promise<number | null> {
  const token = parseCookies(req.headers.get("cookie"))[COOKIE_NAME];
  if (!token) return null;
  return await validateSession(token);
}

export function sessionCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SEC}${secure}`;
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function sessionTokenFromRequest(req: Request): string | null {
  return parseCookies(req.headers.get("cookie"))[COOKIE_NAME] ?? null;
}
