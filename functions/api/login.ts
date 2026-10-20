interface Env {
  APP_PASSWORD: string;
  SESSION_SECRET: string;
}

const COOKIE_NAME = "auth_session";
const SESSION_DURATION_SEC = 60 * 60 * 24 * 7;

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    return json({ error: "Server misconfigured" }, 500);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const record = attempts.get(ip);

  if (record && record.resetAt > now) {
    if (record.count >= MAX_ATTEMPTS) {
      return json({ error: "Too many attempts. Try again later." }, 429);
    }
  } else {
    attempts.set(ip, { count: 0, resetAt: now + WINDOW_MS });
  }

  let password = "";
  try {
    const body = await request.json<{ password?: string }>();
    password = body.password || "";
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  if (!timingSafeStringEqual(password, env.APP_PASSWORD)) {
    const r = attempts.get(ip)!;
    r.count += 1;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return json({ error: "Invalid password" }, 401);
  }

  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + SESSION_DURATION_SEC,
  };
  const payloadB64 = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(payloadB64, env.SESSION_SECRET);
  const token = `${payloadB64}.${sig}`;

  attempts.delete(ip);

  const cookie = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${SESSION_DURATION_SEC}`,
    `Path=/`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Strict`,
  ].join("; ");

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
};

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
