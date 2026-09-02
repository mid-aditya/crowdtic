"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function b64url(bytes: Uint8Array) {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function signDevToken(userId: string, eventId: string) {
  const sec = "dev-only-32chars-super-secret-jwt!!";
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 600;
  const jti = crypto.randomUUID();
  const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(new TextEncoder().encode(JSON.stringify({ iss: "tiket-waiting-room", aud: "tiket-checkout", iat: now, nbf: now, exp, jti, user_id: userId, event_id: eventId })));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sec), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

function CheckoutInner() {
  const sp = useSearchParams();
  const eventId = sp.get("event_id") || "550e8400-e29b-41d4-a716-446655440010";
  const [catId, setCatId] = useState("550e8400-e29b-41d4-a716-446655440020");
  const [seatInput, setSeatInput] = useState("");
  const [seats, setSeats] = useState<{ ID: string; SeatNumber: string; Status: string }[]>([]);
  const [result, setResult] = useState<any>(null);
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const bookingBase = process.env.NEXT_PUBLIC_BOOKING_BASE || "http://localhost:8080";
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8081";

  useEffect(() => {
    setToken(localStorage.getItem("queue_token") || "");
    fetch(`${apiBase}/api/events/${eventId}/seats?category=${catId}`)
      .then((r) => r.json())
      .then((j) => setSeats((j.seats || []).slice(0, 80)))
      .catch(() => {});
  }, [apiBase, eventId, catId]);

  async function ensureToken() {
    if (token) return token;
    const uid = localStorage.getItem("tiket_user_id") || crypto.randomUUID();
    localStorage.setItem("tiket_user_id", uid);
    const t = await signDevToken(uid, eventId);
    localStorage.setItem("queue_token", t);
    setToken(t);
    return t;
  }

  async function hold() {
    setErr("");
    const t = await ensureToken();
    const list = seatInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) return setErr("Isi seat_ids — pilih dari grid atau paste UUID koma-pisah.");
    try {
      const res = await fetch(`${bookingBase}/api/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}`, "x-queue-token": t },
        body: JSON.stringify({ event_id: eventId, category_id: catId, seat_ids: list, idempotency_key: crypto.randomUUID() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `hold ${res.status}`);
      setResult({ phase: "HELD", ...j, seats: list });
    } catch (e: any) {
      setErr(e.message || String(e));
    }
  }

  async function commit() {
    setErr("");
    const t = token || (await ensureToken());
    const list = seatInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!result?.hold_id) return setErr("Hold dulu.");
    try {
      const res = await fetch(`${bookingBase}/api/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}`, "x-queue-token": t },
        body: JSON.stringify({ hold_id: result.hold_id, idempotency_key: crypto.randomUUID(), seat_ids: list }),
      });
      const j = await res.json();
      if (!res.ok && !j.order_id) throw new Error(j.error || j.warning || `commit ${res.status}`);
      setResult({ phase: "PAID", ...j });
    } catch (e: any) {
      setErr(e.message || String(e));
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-8 sm:px-6 lg:px-8">
      <a href="/" className="font-mono text-xs tracking-widest text-zinc-500 hover:text-ink">
        ← Kembali ke storefront
      </a>
      <div className="mt-4 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-[24px] border border-ink/10 bg-white p-6 shadow-hard">
          <div className="font-mono text-[11px] tracking-[0.18em] text-zinc-500">CHECKOUT MANUAL • BOOKING :8080</div>
          <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-ink">Hold 10 menit → Commit</h1>
          <p className="mt-2 font-body text-sm leading-6 text-zinc-600">
            Halaman ini untuk yang mau paste UUID langsung (tanpa peta). Flow tetap sama: queue token HMAC 45s, hold atomic di Redis Lua, commit → SOLD di Postgres partitioned.
          </p>

          <div className="mt-6 space-y-3">
            <label className="block">
              <span className="font-mono text-[11px] tracking-widest text-zinc-500">EVENT_ID</span>
              <input value={eventId} readOnly className="mt-1 w-full rounded-xl border border-ink/15 bg-paper px-3 py-2.5 font-mono text-xs text-zinc-700" />
            </label>
            <label className="block">
              <span className="font-mono text-[11px] tracking-widest text-zinc-500">CATEGORY_ID</span>
              <select value={catId} onChange={(e) => setCatId(e.target.value)} className="mt-1 w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 font-mono text-xs">
                <option value="550e8400-e29b-41d4-a716-446655440020">VIP — Rp 150.000.000 (500)</option>
                <option value="550e8400-e29b-41d4-a716-446655440021">Festival A — Rp 75.000.000 (5000)</option>
              </select>
            </label>
            <label className="block">
              <span className="font-mono text-[11px] tracking-widest text-zinc-500">SEAT_IDS (koma-pisah, UUID)</span>
              <textarea
                value={seatInput}
                onChange={(e) => setSeatInput(e.target.value)}
                placeholder="188a5ee5-9b43-48b4-b366-..., ..."
                rows={3}
                className="mt-1 w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 font-mono text-xs"
              />
            </label>

            {/* quick pick */}
            <div className="rounded-xl border border-dashed border-ink/15 bg-paper p-3">
              <div className="font-mono text-[10px] tracking-widest text-zinc-500">QUICK PICK ({seats.length} seats loaded)</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {seats.slice(0, 40).map((s) => (
                  <button
                    key={s.ID}
                    onClick={() => setSeatInput((prev) => (prev ? `${prev}, ${s.ID}` : s.ID))}
                    className={`rounded-full border px-2.5 py-1 font-mono text-[11px] ${s.Status !== "AVAILABLE" ? "border-zinc-200 bg-zinc-100 text-zinc-400" : "border-ink/15 bg-white hover:bg-amber"}`}
                    title={`${s.SeatNumber} ${s.Status}`}
                  >
                    {s.SeatNumber}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button onClick={hold} className="flex-1 rounded-full bg-vermilion py-3 font-mono text-xs font-black tracking-widest text-white hover:bg-vermilion-2">
                HOLD 10 MENIT
              </button>
              <button onClick={commit} className="flex-1 rounded-full bg-ink py-3 font-mono text-xs font-black tracking-widest text-white hover:bg-surface">
                COMMIT / BAYAR
              </button>
            </div>
            {err && <div className="rounded-xl bg-red-500/10 px-3 py-2 font-mono text-xs text-red-600">{err}</div>}
            <div className={`rounded-full px-3 py-2 text-center font-mono text-[11px] font-bold tracking-widest ${token ? "bg-teal text-ink" : "bg-amber text-ink"}`}>{token ? "TOKEN AKTIF — siap hold/commit" : "TOKEN BELUM ADA — akan auto-sign dev token"}</div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-[24px] bg-ink p-6 text-white">
            <div className="font-mono text-[10px] tracking-[0.18em] text-zinc-400">RESULT</div>
            {result ? (
              <pre className="mt-3 overflow-auto rounded-xl bg-white/10 p-3 font-mono text-xs leading-4 text-zinc-100">{JSON.stringify(result, null, 2)}</pre>
            ) : (
              <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-4 font-body text-sm leading-6 text-zinc-300">Belum ada transaksi. Hold dulu, lalu commit. Idempotency key auto-generated tiap klik.</div>
            )}
            <div className="mt-4 rounded-xl bg-white p-3 font-mono text-[11px] leading-4 text-zinc-600">
              Tanpa token → <b>401</b>. Redis Lua yang pegang stok, bukan <code className="rounded bg-paper-2 px-1">SELECT FOR UPDATE</code>. Timeout 10 menit auto-release.
            </div>
          </div>
          <div className="rounded-2xl border border-ink/10 bg-white p-4">
            <div className="font-mono text-[11px] tracking-widest text-zinc-500">TOKEN SAAT INI</div>
            <div className="mt-2 break-all font-mono text-[11px] leading-4 text-zinc-700">{token ? `${token.slice(0, 64)}…` : "—"}</div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => token && navigator.clipboard.writeText(token)} disabled={!token} className="rounded-full bg-ink px-3 py-1.5 font-mono text-xs font-bold text-white disabled:opacity-40">
                COPY
              </button>
              <button
                onClick={() => {
                  localStorage.removeItem("queue_token");
                  setToken("");
                }}
                className="rounded-full border border-ink/15 bg-white px-3 py-1.5 font-mono text-xs font-bold text-ink"
              >
                CLEAR
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
export default function CheckoutPage() {
  return (
    <Suspense>
      <CheckoutInner />
    </Suspense>
  );
}
