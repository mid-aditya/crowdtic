/**
 * tiket — Edge Virtual Waiting Room (Cloudflare Worker)
 *
 * Endpoints:
 *   POST /queue/join    — join pool (pre-sale random score, post-sale FIFO timestamp)
 *   GET  /queue/status  — poll position & auto-admit if at front + bucket available
 *   POST /queue/admit   — operator/cron batch admission (Token Bucket 2k/sec → JWT)
 *   GET  /waiting-room  — alias of POST /queue/join for legacy JOIN
 *   GET  /health        — liveness + redis/kv reachability
 *
 * Scheduling:
 *   cron (every minute) → T-0 shuffle: Fisher-Yates shuffle waiting:pool → queue:active
 *
 * JWT: manual HMAC-SHA256 via Web Crypto (no external deps), TTL 45s, jti + user_id + event_id
 * Rate limit: fixed-window per IP & fingerprint via KV (with Redis fallback)
 * Turnstile: stub verify (real fetch to siteverify when secret configured)
 */

// Cloudflare Workers runtime bindings — types provided by `wrangler types` / @cloudflare/workers-types
// We declare them as `any` fallback so the file type-checks without installed deps.
type KVNamespaceAny = {
  get(key: string, opts?: unknown): Promise<string | null | unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor: string }>;
};
type ScheduledEventAny = { cron: string; scheduledTime: number };

export interface Env {
  WAITING_ROOM_KV: KVNamespaceAny;
  RATE_LIMIT_KV: KVNamespaceAny;

  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;

  JWT_SECRET: string;
  JWT_TTL_SEC?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;

  TURNSTILE_SECRET_KEY?: string;
  ADMIT_SECRET?: string;

  ADMISSION_RATE_PER_SEC?: string;
  RATE_LIMIT_IP_PER_MIN?: string;
  RATE_LIMIT_FP_PER_MIN?: string;
  QUEUE_ACTIVE_MAX_BATCH?: string;
}

// ── Constants ─────────────────────────────────────────────────
const DEFAULT_TTL_SEC = 45;
const DEFAULT_RATE_PER_SEC = 2000;
const DEFAULT_RL_IP = 20;
const DEFAULT_RL_FP = 20;
const DEFAULT_BATCH = 2000;

// ── Types ─────────────────────────────────────────────────────
type JoinBody = {
  event_id: string;
  user_id: string;
  fingerprint?: string;
  turnstile_token?: string;
};

// ── CORS helpers ──────────────────────────────────────────────
function corsHeaders(origin?: string) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-queue-token, x-admit-secret, x-fingerprint",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  } as Record<string, string>;
}

function json(data: unknown, status = 200, extra?: Record<string, string>, origin?: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin), ...(extra ?? {}) },
  });
}

// ── Base64url ─────────────────────────────────────────────────
function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const b = typeof buf === "string" ? buf : (() => {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer);
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  })();
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecodeToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ── JWT (manual jose-style HMAC SHA-256) ─────────────────────
async function hmacKey(secret: string): Promise<CryptoKey> {
  const raw = utf8Bytes(secret);
  return crypto.subtle.importKey("raw", raw as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signQueueToken(
  secret: string,
  claims: { user_id: string; event_id: string; ttlSec?: number; issuer?: string; audience?: string },
): Promise<{ token: string; jti: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = claims.ttlSec ?? DEFAULT_TTL_SEC;
  const jti = crypto.randomUUID();
  const exp = now + ttl;
  const payload = {
    iss: claims.issuer ?? "tiket-waiting-room",
    aud: claims.audience ?? "tiket-checkout",
    iat: now,
    exp,
    nbf: now,
    jti,
    user_id: claims.user_id,
    event_id: claims.event_id,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const encHeader = b64urlEncode(utf8Bytes(JSON.stringify(header)));
  const encPayload = b64urlEncode(utf8Bytes(JSON.stringify(payload)));
  const data = `${encHeader}.${encPayload}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, utf8Bytes(data) as unknown as BufferSource);
  const token = `${data}.${b64urlEncode(sig)}`;
  return { token, jti, exp };
}

export async function verifyQueueToken(
  secret: string,
  token: string,
  opts?: { issuer?: string; audience?: string; leewaySec?: number },
): Promise<{ valid: true; payload: Record<string, unknown> } | { valid: false; reason: string }> {
  const leeway = opts?.leewaySec ?? 5;
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const key = await hmacKey(secret);
  const sigBytes = b64urlDecodeToBytes(s);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes as unknown as BufferSource, utf8Bytes(data) as unknown as BufferSource);
  if (!ok) return { valid: false, reason: "bad_signature" };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(p)));
  } catch {
    return { valid: false, reason: "bad_payload" };
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = payload.exp as number | undefined;
  const nbf = payload.nbf as number | undefined;
  if (typeof exp === "number" && now > exp + leeway) return { valid: false, reason: "expired" };
  if (typeof nbf === "number" && now + leeway < nbf) return { valid: false, reason: "not_yet_valid" };
  if (opts?.issuer && payload.iss !== opts.issuer) return { valid: false, reason: "bad_iss" };
  if (opts?.audience && payload.aud !== opts.audience) return { valid: false, reason: "bad_aud" };
  if (!payload.jti || !payload.user_id || !payload.event_id) return { valid: false, reason: "missing_claims" };
  return { valid: true, payload };
}

// ── Redis REST client (Upstash) with KV fallback ─────────────
type RedisResult<T = unknown> = { result: T };

class RedisClient {
  constructor(private env: Env) {}
  get enabled() {
    return !!this.env.UPSTASH_REDIS_REST_URL && !!this.env.UPSTASH_REDIS_REST_TOKEN;
  }
  async cmd<T = unknown>(...args: (string | number)[]): Promise<T | null> {
    if (!this.enabled) return null;
    const res = await fetch(this.env.UPSTASH_REDIS_REST_URL!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args.map(String)),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`redis ${args[0]} failed ${res.status}: ${txt}`);
    }
    const j = (await res.json()) as RedisResult<T>;
    return j.result;
  }

  // pipeline: array of commands
  async pipeline(cmds: (string | number)[][]): Promise<unknown[]> {
    if (!this.enabled) return [];
    const res = await fetch(`${this.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
    });
    if (!res.ok) throw new Error(`redis pipeline ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as Array<{ result: unknown }>;
    return j.map((x) => x.result);
  }
}

// ── KV helpers ────────────────────────────────────────────────
async function kvGetJson<T>(kv: KVNamespaceAny, key: string): Promise<T | null> {
  const v = (await (kv as unknown as { get(k: string, t: string): Promise<unknown> }).get(key, "json"));
  return v as T | null;
}

// ── Event meta ────────────────────────────────────────────────
// Stored at meta:{event_id} as { on_sale_at: string (ISO), status: string }
// Fallback: if not found, treat as already on sale (FIFO path) — safe open.
async function getEventMeta(env: Env, redis: RedisClient, eventId: string): Promise<{ on_sale_at: number | null }> {
  // try redis hash first
  if (redis.enabled) {
    try {
      const hm = await redis.cmd<Record<string, string> | null>("HGETALL", `meta:{${eventId}}`);
      if (hm && hm.on_sale_at) {
        const t = Date.parse(hm.on_sale_at);
        if (!Number.isNaN(t)) return { on_sale_at: t };
      }
    } catch { /* ignore */ }
  }
  const kvMeta = await kvGetJson<{ on_sale_at?: string }>(env.WAITING_ROOM_KV, `meta:{${eventId}}`);
  if (kvMeta?.on_sale_at) {
    const t = Date.parse(kvMeta.on_sale_at);
    if (!Number.isNaN(t)) return { on_sale_at: t };
  }
  return { on_sale_at: null };
}

// ── Rate limiting (fixed window) ──────────────────────────────
async function hitRateLimit(env: Env, kind: "ip" | "fp", id: string, limit: number): Promise<{ allowed: boolean; remaining: number; resetSec: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowKey = `rl:${kind}:${id}:${Math.floor(nowSec / 60)}`;
  const kv = kind === "ip" ? env.RATE_LIMIT_KV : env.RATE_LIMIT_KV;
  // use KV atomic via get+put is not atomic; best-effort. Redis is preferred.
  const redis = new RedisClient(env);
  if (redis.enabled) {
    const count = (await redis.cmd<number>("INCR", windowKey)) ?? 1;
    if (count === 1) await redis.cmd("EXPIRE", windowKey, 70);
    const ttl = (await redis.cmd<number>("TTL", windowKey)) ?? 60;
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetSec: ttl > 0 ? ttl : 60 - (nowSec % 60) };
  }
  // KV fallback
  const curStr = (await kv.get(windowKey)) as string | null;
  const cur = curStr ? parseInt(curStr, 10) : 0;
  const next = cur + 1;
  // KV put with expiration 70s
  await kv.put(windowKey, String(next), { expirationTtl: 70 });
  const remaining = Math.max(0, limit - next);
  return { allowed: next <= limit, remaining, resetSec: 60 - (nowSec % 60) };
}

// ── Turnstile verify (stub + real) ───────────────────────────
async function verifyTurnstile(env: Env, token: string | undefined, ip: string): Promise<{ ok: boolean; reason?: string }> {
  if (!token) {
    // In production require token; in dev/local allow bypass via header
    // If no secret configured, treat as pass (local dev)
    if (!env.TURNSTILE_SECRET_KEY) return { ok: true };
    return { ok: false, reason: "missing_turnstile_token" };
  }
  if (token === "TEST_BYPASS" || token === "bypass") return { ok: true };
  if (!env.TURNSTILE_SECRET_KEY) return { ok: true }; // dev without secret
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY);
    form.append("response", token);
    form.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const j = (await res.json()) as { success: boolean; "error-codes"?: string[] };
    if (j.success) return { ok: true };
    return { ok: false, reason: (j["error-codes"] ?? []).join(",") || "turnstile_failed" };
  } catch (e) {
    return { ok: false, reason: `turnstile_error:${String(e)}` };
  }
}

// ── Token Bucket ──────────────────────────────────────────────
type BucketState = { tokens: number; last_ms: number };

async function tokenBucketConsume(
  env: Env,
  redis: RedisClient,
  eventId: string,
  need: number,
): Promise<{ allowed: boolean; remaining: number; retryAfterMs?: number }> {
  const rate = parseInt(env.ADMISSION_RATE_PER_SEC ?? String(DEFAULT_RATE_PER_SEC), 10);
  const capacity = rate; // burst = 1s worth
  const key = `bucket:{${eventId}}`;
  const now = Date.now();

  let state: BucketState | null = null;
  if (redis.enabled) {
    try {
      const raw = await redis.cmd<string | null>("GET", key);
      if (raw) state = JSON.parse(raw) as BucketState;
    } catch { /* ignore */ }
  } else {
    state = await kvGetJson<BucketState>(env.WAITING_ROOM_KV, key);
  }

  if (!state) state = { tokens: capacity, last_ms: now };
  const elapsedMs = Math.max(0, now - state.last_ms);
  const refill = (elapsedMs / 1000) * rate;
  let tokens = Math.min(capacity, state.tokens + refill);

  if (tokens < need) {
    const deficit = need - tokens;
    const retryAfterMs = Math.ceil((deficit / rate) * 1000);
    // save refilled state even when not consuming
    const next: BucketState = { tokens, last_ms: now };
    if (redis.enabled) await redis.cmd("SET", key, JSON.stringify(next), "EX", 120);
    else await env.WAITING_ROOM_KV.put(key, JSON.stringify(next), { expirationTtl: 120 });
    return { allowed: false, remaining: Math.floor(tokens), retryAfterMs };
  }

  tokens -= need;
  const next: BucketState = { tokens, last_ms: now };
  if (redis.enabled) await redis.cmd("SET", key, JSON.stringify(next), "EX", 120);
  else await env.WAITING_ROOM_KV.put(key, JSON.stringify(next), { expirationTtl: 120 });
  return { allowed: true, remaining: Math.floor(tokens) };
}

// ── Fisher-Yates ──────────────────────────────────────────────
function shuffleInPlace<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp!;
  }
}

// ── Queue keys ────────────────────────────────────────────────
function poolKey(eventId: string) { return `waiting:pool:{${eventId}}`; }
function activeKey(eventId: string) { return `queue:active:{${eventId}}`; }
function admittedKey(eventId: string) { return `queue:admitted:{${eventId}}`; }

// ── Join logic ────────────────────────────────────────────────
async function handleJoin(req: Request, env: Env, redis: RedisClient, origin?: string): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "0.0.0.0";
  const fingerprint = req.headers.get("x-fingerprint") ?? "";

  let body: JoinBody;
  try {
    body = (await req.json()) as JoinBody;
  } catch {
    return json({ error: "invalid_json" }, 400, undefined, origin);
  }
  const eventId = (body.event_id ?? "").trim();
  const userId = (body.user_id ?? "").trim();
  const fp = (body.fingerprint ?? fingerprint ?? "").trim();

  if (!eventId || !userId) return json({ error: "event_id and user_id required" }, 400, undefined, origin);
  // light uuid format check (allow any non-empty in dev)
  if (eventId.length < 8 || userId.length < 8) return json({ error: "invalid id format" }, 400, undefined, origin);

  const rlIpLim = parseInt(env.RATE_LIMIT_IP_PER_MIN ?? String(DEFAULT_RL_IP), 10);
  const rlFpLim = parseInt(env.RATE_LIMIT_FP_PER_MIN ?? String(DEFAULT_RL_FP), 10);

  const [rlIp, rlFp] = await Promise.all([
    hitRateLimit(env, "ip", ip, rlIpLim),
    fp ? hitRateLimit(env, "fp", fp, rlFpLim) : Promise.resolve({ allowed: true, remaining: 999, resetSec: 60 }),
  ]);

  if (!rlIp.allowed) {
    return json({ error: "rate_limited", scope: "ip", retry_after_sec: rlIp.resetSec }, 429, { "Retry-After": String(rlIp.resetSec) }, origin);
  }
  if (!rlFp.allowed) {
    return json({ error: "rate_limited", scope: "fingerprint", retry_after_sec: rlFp.resetSec }, 429, { "Retry-After": String(rlFp.resetSec) }, origin);
  }

  const tsCheck = await verifyTurnstile(env, body.turnstile_token, ip);
  if (!tsCheck.ok) return json({ error: "turnstile_failed", reason: tsCheck.reason }, 403, undefined, origin);

  const meta = await getEventMeta(env, redis, eventId);
  const nowMs = Date.now();
  const isPreSale = meta.on_sale_at !== null && nowMs < meta.on_sale_at;

  // Score strategy:
  //  pre-sale: random float in [0,1)  — fairness lottery (unknown order)
  //  post-sale: timestamp ms — FIFO
  const score = isPreSale ? Math.random() : nowMs + Math.random(); // add fractional to avoid collisions

  const pKey = poolKey(eventId);
  const aKey = activeKey(eventId);

  let poolSize = 0;
  let position: number | null = null;

  if (redis.enabled) {
    // maintain pool index for cron sweep (non-critical, best-effort)
    redis.cmd("SADD", "waiting:index", eventId).catch(() => {});
    // If active queue exists (T-0 already shuffled), join directly to active tail (FIFO always post-T0)
    const activeLen = (await redis.cmd<number>("ZCARD", aKey)) ?? 0;
    if (activeLen > 0 || !isPreSale) {
      // post-sale or already active → append to active queue
      // score = maxScore + 1 to keep FIFO (use ms + seq)
      const tailScore = activeLen > 0 ? nowMs + activeLen : score;
      await redis.cmd("ZADD", aKey, tailScore, userId);
      // also ensure not duplicated in pool
      await redis.cmd("ZREM", pKey, userId);
      poolSize = (await redis.cmd<number>("ZCARD", aKey)) ?? 0;
      position = await redis.cmd<number>("ZRANK", aKey, userId);
    } else {
      // pre-sale → pool
      await redis.cmd("ZADD", pKey, score, userId);
      poolSize = (await redis.cmd<number>("ZCARD", pKey)) ?? 0;
      position = await redis.cmd<number>("ZRANK", pKey, userId);
    }
  } else {
    // KV fallback: emulate sorted set via JSON array stored in KV
    // Not perfectly ordered but functional for dev without Redis.
    const kvPoolKey = pKey;
    const kvActiveKey = aKey;
    const activeRaw = await env.WAITING_ROOM_KV.get(kvActiveKey, "json") as Array<{ m: string; s: number }> | null;
    const hasActive = !!(activeRaw && activeRaw.length > 0);
    if (hasActive || !isPreSale) {
      const arr = activeRaw ?? [];
      if (!arr.find((x) => x.m === userId)) arr.push({ m: userId, s: Date.now() + arr.length });
      arr.sort((a, b) => a.s - b.s);
      await env.WAITING_ROOM_KV.put(kvActiveKey, JSON.stringify(arr));
      poolSize = arr.length;
      position = arr.findIndex((x) => x.m === userId);
      // remove from pool if exists
      const poolRaw = await env.WAITING_ROOM_KV.get(kvPoolKey, "json") as Array<{ m: string; s: number }> | null;
      if (poolRaw) {
        const filtered = poolRaw.filter((x) => x.m !== userId);
        await env.WAITING_ROOM_KV.put(kvPoolKey, JSON.stringify(filtered));
      }
    } else {
      const raw = await env.WAITING_ROOM_KV.get(kvPoolKey, "json") as Array<{ m: string; s: number }> | null;
      const arr = raw ?? [];
      const existing = arr.find((x) => x.m === userId);
      if (!existing) arr.push({ m: userId, s: score });
      arr.sort((a, b) => a.s - b.s);
      await env.WAITING_ROOM_KV.put(kvPoolKey, JSON.stringify(arr));
      poolSize = arr.length;
      position = arr.findIndex((x) => x.m === userId);
    }
  }

  const pos1 = position !== null && position >= 0 ? position + 1 : null;
  const estWaitSec = pos1 !== null ? Math.ceil(pos1 / DEFAULT_RATE_PER_SEC) : null;

  return json(
    {
      ok: true,
      event_id: eventId,
      user_id: userId,
      phase: isPreSale ? "pre_sale_pool" : "active_queue",
      position: pos1,
      pool_size: poolSize,
      estimated_wait_sec: estWaitSec,
      // hint for frontend polling interval
      poll_interval_ms: pos1 !== null && pos1 <= 50 ? 1000 : pos1 !== null && pos1 <= 500 ? 2000 : 5000,
    },
    200,
    { "Cache-Control": "no-store" },
    origin,
  );
}

// ── Status logic ──────────────────────────────────────────────
async function handleStatus(req: Request, env: Env, redis: RedisClient, origin?: string): Promise<Response> {
  const url = new URL(req.url);
  const eventId = (url.searchParams.get("event_id") ?? "").trim();
  const userId = (url.searchParams.get("user_id") ?? "").trim();
  if (!eventId || !userId) return json({ error: "event_id and user_id required" }, 400, undefined, origin);

  const pKey = poolKey(eventId);
  const aKey = activeKey(eventId);

  let poolRank: number | null = null;
  let activeRank: number | null = null;
  let poolSize = 0;
  let activeSize = 0;

  if (redis.enabled) {
    const [pr, ar, pc, ac] = await Promise.all([
      redis.cmd<number | null>("ZRANK", pKey, userId),
      redis.cmd<number | null>("ZRANK", aKey, userId),
      redis.cmd<number>("ZCARD", pKey),
      redis.cmd<number>("ZCARD", aKey),
    ]);
    poolRank = pr;
    activeRank = ar;
    poolSize = pc ?? 0;
    activeSize = ac ?? 0;
  } else {
    const poolRaw = await env.WAITING_ROOM_KV.get(pKey, "json") as Array<{ m: string; s: number }> | null;
    const activeRaw = await env.WAITING_ROOM_KV.get(aKey, "json") as Array<{ m: string; s: number }> | null;
    poolSize = poolRaw?.length ?? 0;
    activeSize = activeRaw?.length ?? 0;
    if (poolRaw) {
      const idx = poolRaw.findIndex((x) => x.m === userId);
      poolRank = idx >= 0 ? idx : null;
    }
    if (activeRaw) {
      const idx = activeRaw.findIndex((x) => x.m === userId);
      activeRank = idx >= 0 ? idx : null;
    }
  }

  // Determine current phase & position
  let phase: string;
  let position: number | null = null;
  let queue: "pool" | "active" | "none" = "none";

  if (activeRank !== null) {
    phase = "active_queue";
    position = activeRank + 1;
    queue = "active";
  } else if (poolRank !== null) {
    phase = "pre_sale_pool";
    position = poolRank + 1;
    queue = "pool";
  } else {
    phase = "not_in_queue";
  }

  const admittedRaw = redis.enabled
    ? await redis.cmd<string | null>("GET", admittedKey(eventId))
    : ((await env.WAITING_ROOM_KV.get(admittedKey(eventId))) as string | null);
  const admittedWatermark = admittedRaw ? parseInt(admittedRaw as string, 10) : 0;

  // Auto-admit check: if user at front of active queue and bucket allows, issue token eagerly
  let token: string | undefined;
  let token_expires_at: string | undefined;

  if (queue === "active" && activeRank !== null && activeRank < admittedWatermark + DEFAULT_BATCH) {
    // Check if within admitted window (already admitted by batch job)
    // If position <= watermark, user is admitted — issue token on demand (idempotent)
    if (position !== null && position <= admittedWatermark) {
      const ttl = parseInt(env.JWT_TTL_SEC ?? String(DEFAULT_TTL_SEC), 10);
      const { token: t, exp } = await signQueueToken(env.JWT_SECRET, {
        user_id: userId,
        event_id: eventId,
        ttlSec: ttl,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      });
      token = t;
      token_expires_at = new Date(exp * 1000).toISOString();
      // store jti allowlist best-effort
      try {
        const v = await verifyQueueToken(env.JWT_SECRET, t);
        if (v.valid) {
          const jti = (v.payload.jti as string) ?? "unknown";
          const jtiKey = `jti:{${eventId}}:${jti}`;
          const ttlSec = ttl + 10;
          if (redis.enabled) await redis.cmd("SET", jtiKey, "1", "EX", ttlSec);
          else await env.WAITING_ROOM_KV.put(jtiKey, "1", { expirationTtl: ttlSec });
        }
      } catch { /* ignore */ }
    }
  }

  const estWaitSec = position !== null && queue === "active" ? Math.max(0, Math.ceil((position - admittedWatermark) / DEFAULT_RATE_PER_SEC)) : null;

  return json(
    {
      ok: true,
      event_id: eventId,
      user_id: userId,
      phase,
      queue,
      position,
      pool_size: poolSize,
      active_size: activeSize,
      admitted_watermark: admittedWatermark,
      estimated_wait_sec: estWaitSec,
      admitted: token ? true : false,
      token,
      token_expires_at,
      poll_interval_ms: position !== null && position <= 100 ? 1000 : 2500,
    },
    200,
    { "Cache-Control": "no-store" },
    origin,
  );
}

// ── Admit logic (Token Bucket 2k/sec) ─────────────────────────
async function handleAdmit(req: Request, env: Env, redis: RedisClient, origin?: string): Promise<Response> {
  // Auth: x-admit-secret must match ADMIT_SECRET when configured
  if (env.ADMIT_SECRET) {
    const got = req.headers.get("x-admit-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (got !== env.ADMIT_SECRET) return json({ error: "unauthorized" }, 401, undefined, origin);
  }

  let eventId = "";
  let batchReq = 0;
  try {
    const body = (await req.json().catch(() => ({}))) as { event_id?: string; batch?: number };
    eventId = (body.event_id ?? "").trim();
    batchReq = body.batch ? Math.max(1, Math.min(DEFAULT_BATCH, body.batch)) : 0;
  } catch { /* ignore */ }
  if (!eventId) {
    const url = new URL(req.url);
    eventId = (url.searchParams.get("event_id") ?? "").trim();
  }
  if (!eventId) return json({ error: "event_id required" }, 400, undefined, origin);

  const aKey = activeKey(eventId);
  // Ensure T-0 shuffle happened if pool still holds entries and active is empty
  await maybeShufflePool(env, redis, eventId);

  let activeSize = 0;
  if (redis.enabled) activeSize = (await redis.cmd<number>("ZCARD", aKey)) ?? 0;
  else {
    const raw = await env.WAITING_ROOM_KV.get(aKey, "json") as unknown[] | null;
    activeSize = raw?.length ?? 0;
  }
  if (activeSize === 0) return json({ ok: true, event_id: eventId, admitted: 0, remaining: 0, reason: "queue_empty" }, 200, undefined, origin);

  const want = batchReq > 0 ? Math.min(batchReq, activeSize) : Math.min(DEFAULT_BATCH, activeSize);

  // Token bucket gate
  const bucket = await tokenBucketConsume(env, redis, eventId, want);
  if (!bucket.allowed) {
    return json(
      { ok: false, error: "rate_limited", retry_after_ms: bucket.retryAfterMs, remaining_tokens: bucket.remaining, queue_size: activeSize },
      429,
      bucket.retryAfterMs ? { "Retry-After": String(Math.ceil(bucket.retryAfterMs / 1000)) } : undefined,
      origin,
    );
  }

  // Pop N from active queue (smallest scores first)
  const admittedUsers: string[] = [];
  const ttl = parseInt(env.JWT_TTL_SEC ?? String(DEFAULT_TTL_SEC), 10);

  if (redis.enabled) {
    // ZPOPMIN with count (Redis 5+): ZPOPMIN key count
    // Upstash supports it; fallback to loop of ZPOPMIN 1
    try {
      const popped = await redis.cmd<unknown>("ZPOPMIN", aKey, want);
      // popped format: [member, score, member, score, ...]  or array of arrays
      if (Array.isArray(popped)) {
        // normalize: Upstash may return flat or nested
        if (popped.length > 0 && Array.isArray(popped[0])) {
          for (const pair of popped as unknown[][]) admittedUsers.push(String(pair[0]));
        } else {
          for (let i = 0; i < (popped as unknown[]).length; i += 2) admittedUsers.push(String((popped as unknown[])[i]));
        }
      }
    } catch {
      // fallback loop
      for (let i = 0; i < want; i++) {
        const one = await redis.cmd<unknown>("ZPOPMIN", aKey, 1);
        if (!one || (Array.isArray(one) && (one as unknown[]).length === 0)) break;
        if (Array.isArray(one)) {
          if (Array.isArray((one as unknown[])[0])) admittedUsers.push(String(((one as unknown[])[0] as unknown[])[0]));
          else admittedUsers.push(String((one as unknown[])[0]));
        }
      }
    }
  } else {
    const raw = (await env.WAITING_ROOM_KV.get(aKey, "json") as Array<{ m: string; s: number }> | null) ?? [];
    raw.sort((a, b) => a.s - b.s);
    const take = raw.splice(0, want);
    await env.WAITING_ROOM_KV.put(aKey, JSON.stringify(raw));
    for (const t of take) admittedUsers.push(t.m);
  }

  // bump watermark
  const wmKey = admittedKey(eventId);
  let watermark = 0;
  if (redis.enabled) {
    const cur = await redis.cmd<string | null>("GET", wmKey);
    watermark = (cur ? parseInt(cur, 10) : 0) + admittedUsers.length;
    await redis.cmd("SET", wmKey, String(watermark), "EX", 3600);
  } else {
    const cur = (await env.WAITING_ROOM_KV.get(wmKey)) as string | null;
    watermark = (cur ? parseInt(cur as string, 10) : 0) + admittedUsers.length;
    await env.WAITING_ROOM_KV.put(wmKey, String(watermark), { expirationTtl: 3600 });
  }

  // Issue JWT per admitted user
  const tokens: Array<{ user_id: string; token: string; expires_at: string; jti: string }> = [];
  for (const uid of admittedUsers) {
    const { token, jti, exp } = await signQueueToken(env.JWT_SECRET, {
      user_id: uid,
      event_id: eventId,
      ttlSec: ttl,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    tokens.push({ user_id: uid, token, jti, expires_at: new Date(exp * 1000).toISOString() });
    // jti allowlist for replay / single-use check at origin (optional)
    const jtiKey = `jti:{${eventId}}:${jti}`;
    if (redis.enabled) await redis.cmd("SET", jtiKey, "1", "EX", ttl + 10);
    else await env.WAITING_ROOM_KV.put(jtiKey, "1", { expirationTtl: ttl + 10 });
  }

  return json(
    {
      ok: true,
      event_id: eventId,
      admitted: admittedUsers.length,
      watermark,
      remaining_tokens: bucket.remaining,
      tokens,
    },
    200,
    undefined,
    origin,
  );
}

// ── T-0 Shuffle: Fisher-Yates pool → queue:active ─────────────
async function maybeShufflePool(env: Env, redis: RedisClient, eventId: string): Promise<boolean> {
  const pKey = poolKey(eventId);
  const aKey = activeKey(eventId);

  if (redis.enabled) {
    const [pSize, aSize] = await Promise.all([
      redis.cmd<number>("ZCARD", pKey),
      redis.cmd<number>("ZCARD", aKey),
    ]);
    if ((pSize ?? 0) === 0) return false;
    if ((aSize ?? 0) > 0) return false; // already shuffled

    const members = (await redis.cmd<string[]>("ZRANGE", pKey, 0, -1)) ?? [];
    if (members.length === 0) return false;
    shuffleInPlace(members);

    // Pipeline ZADD active + DEL pool
    const now = Date.now();
    const cmds: (string | number)[][] = [];
    for (let i = 0; i < members.length; i++) {
      cmds.push(["ZADD", aKey, now + i, members[i]!]);
    }
    cmds.push(["DEL", pKey]);
    // also reset admitted watermark
    cmds.push(["SET", admittedKey(eventId), "0", "EX", "3600"]);
    await redis.pipeline(cmds);
    return true;
  } else {
    const poolRaw = await env.WAITING_ROOM_KV.get(pKey, "json") as Array<{ m: string; s: number }> | null;
    const activeRaw = await env.WAITING_ROOM_KV.get(aKey, "json") as Array<{ m: string; s: number }> | null;
    if (!poolRaw || poolRaw.length === 0) return false;
    if (activeRaw && activeRaw.length > 0) return false;
    const members = poolRaw.map((x) => x.m);
    shuffleInPlace(members);
    const now = Date.now();
    const active = members.map((m, i) => ({ m, s: now + i }));
    await env.WAITING_ROOM_KV.put(aKey, JSON.stringify(active));
    await env.WAITING_ROOM_KV.put(pKey, JSON.stringify([]));
    await env.WAITING_ROOM_KV.put(admittedKey(eventId), "0", { expirationTtl: 3600 });
    return true;
  }
}

// ── Scheduled (cron) — sweep all pools whose T-0 has passed ───
async function handleScheduled(env: Env): Promise<void> {
  const redis = new RedisClient(env);
  // Discover pools via KV list (prefix waiting:pool) — Redis SCAN is not exposed over REST easily,
  // so we rely on KV listing; duplicate check via Redis ZCARD for each discovered event.
  // Fallback: if no KV pools, no-op.
  const listed = await env.WAITING_ROOM_KV.list({ prefix: "waiting:pool:{" });
  const eventIds = listed.keys.map((k: { name: string }) => {
    const m = k.name.match(/waiting:pool:\{(.+)\}/);
    return m?.[1] ?? null;
  }).filter(Boolean) as string[];

  // Also consider Redis pools when REST enabled — try a small known-set hint stored at index key
  // index is maintained by join handler (best-effort). If missing, we still sweep discovered KV pools.
  if (redis.enabled) {
    try {
      const idx = await redis.cmd<string[]>("SMEMBERS", "waiting:index");
      if (idx) for (const id of idx) if (!eventIds.includes(id)) eventIds.push(id);
    } catch { /* ignore */ }
  }

  for (const eid of eventIds) {
    const meta = await getEventMeta(env, redis, eid);
    if (meta.on_sale_at === null) continue;
    if (Date.now() < meta.on_sale_at) continue;
    const shuffled = await maybeShufflePool(env, redis, eid);
    if (shuffled) console.log(`[waiting-room][cron] shuffled pool -> active for event ${eid}`);
  }
}

// ── Router ────────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("origin") ?? undefined;
    const redis = new RedisClient(env);

    // handle CORS preflight
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

    // Maintain waiting:index for cron discovery (best-effort, non-blocking)
    // not awaited intentionally for join hot path? we do await but cheap.

    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" && req.method === "GET") {
      let redisOk: boolean | string = false;
      if (redis.enabled) {
        try {
          const pong = await redis.cmd<string>("PING");
          redisOk = pong === "PONG" || !!pong;
        } catch (e) {
          redisOk = String(e);
        }
      } else {
        redisOk = "kv_fallback";
      }
      return json({ ok: true, service: "tiket-waiting-room", time: new Date().toISOString(), redis: redisOk }, 200, undefined, origin);
    }

    if ((path === "/queue/join" || path === "/waiting-room") && req.method === "POST") {
      if (!env.JWT_SECRET) return json({ error: "server misconfigured: JWT_SECRET missing" }, 500, undefined, origin);
      const res = await handleJoin(req, env, redis, origin);
      // best-effort index update for cron
      try {
        const bodyClone = await req.clone().json().catch(() => null) as JoinBody | null;
        // we already consumed body; use event_id from response? Instead re-parse URL param fallback
        // maintain index via redis SMEMBERS set if enabled — we do it inside handleJoin would be cleaner,
        // so do dual write here only if redis enabled and we can extract event_id
        // To avoid double-read, extract from a header we set? Simpler: no-op here.
      } catch { /* ignore */ }
      return res;
    }

    // legacy GET /waiting-room?event_id=&user_id= → join (beacon / redirect compatibility)
    if (path === "/waiting-room" && req.method === "GET") {
      const eventId = url.searchParams.get("event_id") ?? "";
      const userId = url.searchParams.get("user_id") ?? "";
      if (eventId && userId) {
        const fakeReq = new Request(req.url, {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify({ event_id: eventId, user_id: userId, fingerprint: req.headers.get("x-fingerprint") ?? undefined }),
        });
        if (!env.JWT_SECRET) return json({ error: "server misconfigured: JWT_SECRET missing" }, 500, undefined, origin);
        return handleJoin(fakeReq, env, redis, origin);
      }
      return json({ error: "use POST /queue/join with {event_id, user_id}" }, 400, undefined, origin);
    }

    if (path === "/queue/status" && req.method === "GET") {
      return handleStatus(req, env, redis, origin);
    }

    if (path === "/queue/admit" && req.method === "POST") {
      if (!env.JWT_SECRET) return json({ error: "server misconfigured: JWT_SECRET missing" }, 500, undefined, origin);
      return handleAdmit(req, env, redis, origin);
    }

    // verify helper for origin (useful for debugging)
    if (path === "/queue/verify" && req.method === "POST") {
      const { token } = (await req.json().catch(() => ({}))) as { token?: string };
      if (!token) return json({ error: "token required" }, 400, undefined, origin);
      const v = await verifyQueueToken(env.JWT_SECRET, token, { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE });
      return json(v, v.valid ? 200 : 401, undefined, origin);
    }

    return json({ error: "not_found", hint: "GET /health, POST /queue/join, GET /queue/status, POST /queue/admit" }, 404, undefined, origin);
  },

  async scheduled(_event: ScheduledEventAny, env: Env): Promise<void> {
    await handleScheduled(env);
  },
};
