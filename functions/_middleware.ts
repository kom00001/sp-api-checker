interface Env {
  APP_PASSWORD: string;
  SESSION_SECRET: string;
}

const COOKIE_NAME = "auth_session";
const SESSION_DURATION_SEC = 60 * 60 * 24 * 7;

const PUBLIC_PATHS = new Set([
  "/login",
  "/login.html",
  "/api/login",
  "/favicon.ico",
]);

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
    return new Response("Server misconfigured: auth secrets missing", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (env.SESSION_SECRET.length < 32) {
    return new Response("Server misconfigured: SESSION_SECRET too short", {
      status: 500,
    });
  }

  if (PUBLIC_PATHS.has(url.pathname)) {
    return next();
  }

  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const token = match ? decodeURIComponent(match[1]) : null;

  const valid = token && (await verifyToken(token, env.SESSION_SECRET));

  if (!valid) {
    if (url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return Response.redirect(`${url.origin}/login`, 302);
  }

  return next();
};

async function verifyToken(token: string, secret: string): Promise<boolean> {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return false;

    const expectedSig = await hmacSign(payloadB64, secret);
    if (!timingSafeStringEqual(expectedSig, sigB64)) return false;

    const payload = JSON.parse(b64urlDecode(payloadB64));
    if (typeof payload.exp !== "number") return false;
    if (payload.exp < Math.floor(Date.now() / 1000)) return false;

    return true;
  } catch {
    return false;
  }
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

function b64urlDecode(s: string): string {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
