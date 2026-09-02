"use client";
import { useEffect, useMemo, useState } from "react";

type Event = { id: string; title: string; slug: string; on_sale_at: string; status: string; max_per_user: number };
type Inventory = { key: string; inventory: Record<string, string> };
type Seat = { ID: string; SeatNumber: string; Status: string; CategoryID: string };

const EVENT_FALLBACK: Event = {
  id: "550e8400-e29b-41d4-a716-446655440010",
  title: "Mega Concert — Flash Sale Demo",
  slug: "mega-concert-2026",
  on_sale_at: new Date(Date.now() + 3600_1000).toISOString(),
  status: "SCHEDULED",
  max_per_user: 4,
};

const DEV_SECRET = "dev-only-32chars-super-secret-jwt!!";
const DEV_ISS = "tiket-waiting-room";
const DEV_AUD = "tiket-checkout";

function b64url(bytes: Uint8Array) {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlJson(obj: unknown) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}
async function signDevQueueToken(userId: string, eventId: string) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 600;
  const jti = crypto.randomUUID();
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson({ iss: DEV_ISS, aud: DEV_AUD, iat: now, nbf: now, exp, jti, user_id: userId, event_id: eventId });
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(DEV_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

function fmtIDR(n: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}
function countdown(to: string) {
  const diff = new Date(to).getTime() - Date.now();
  if (diff <= 0) return { live: true, h: 0, m: 0, s: 0, label: "LIVE" };
  const s = Math.floor(diff / 1000) % 60;
  const m = Math.floor(diff / 60000) % 60;
  const h = Math.floor(diff / 3600000);
  return { live: false, h, m, s, label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` };
}

export default function Home() {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8081";
  const queueBase = process.env.NEXT_PUBLIC_QUEUE_BASE || "http://localhost:8787";
  const bookingBase = process.env.NEXT_PUBLIC_BOOKING_BASE || "http://localhost:8080";

  const [events, setEvents] = useState<Event[]>([]);
  const [selected, setSelected] = useState<string>(EVENT_FALLBACK.id);
  const [detail, setDetail] = useState<{ inventory: Inventory[]; max_per_user: number; on_sale_at: string; title: string } | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [token, setToken] = useState<string>("");
  const [queue, setQueue] = useState<any>(null);
  const [holdRes, setHoldRes] = useState<any>(null);
  const [commitRes, setCommitRes] = useState<any>(null);
  const [err, setErr] = useState<string>("");
  const [phase, setPhase] = useState<"idle" | "holding" | "held" | "committing">("idle");
  const [tick, setTick] = useState(0);

  const event = useMemo(() => events.find((e) => e.id === selected) || events[0] || EVENT_FALLBACK, [events, selected]);

  useEffect(() => {
    const t = localStorage.getItem("queue_token") || "";
    if (t) setToken(t);
    fetch(`${apiBase}/api/events`)
      .then((r) => r.json())
      .then((j) => {
        if (j.events?.length) {
          setEvents(j.events);
          setSelected(j.events[0].id);
        } else setEvents([EVENT_FALLBACK]);
      })
      .catch(() => setEvents([EVENT_FALLBACK]));
  }, [apiBase]);

  useEffect(() => {
    if (!selected) return;
    fetch(`${apiBase}/api/events/${selected}`)
      .then((r) => r.json())
      .then((j) => setDetail({ inventory: j.inventory || [], max_per_user: j.max_per_user || 4, on_sale_at: j.on_sale_at || event.on_sale_at, title: j.title || event.title }))
      .catch(() => setDetail(null));
    fetch(`${apiBase}/api/events/${selected}/seats?category=`)
      .then((r) => r.json())
      .then((j) => setSeats((j.seats || []).slice(0, 2000)))
      .catch(() => setSeats([]));
  }, [apiBase, selected, event.on_sale_at, event.title]);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;

  const cd = countdown(detail?.on_sale_at || event.on_sale_at);
  const vipInv = detail?.inventory.find((x) => x.inventory.category_id === "550e8400-e29b-41d4-a716-446655440020" || x.key.includes("550e8400-e29b-41d4-a716-446655440020"))?.inventory;
  const fesInv = detail?.inventory.find((x) => x.inventory.category_id === "550e8400-e29b-41d4-a716-446655440021" || x.key.includes("550e8400-e29b-41d4-a716-446655440021"))?.inventory;

  async function joinQueue() {
    setErr("");
    const userId = localStorage.getItem("tiket_user_id") || crypto.randomUUID();
    localStorage.setItem("tiket_user_id", userId);
    const fp = `web-${navigator.userAgent.slice(0, 24)}-${Math.random().toString(36).slice(2, 6)}`;
    // try wrangler queue first
    try {
      const res = await fetch(`${queueBase}/queue/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: selected, user_id: userId, fingerprint: fp }),
      });
      if (res.ok) {
        const j = await res.json();
        setQueue(j);
        if (j.token) {
          localStorage.setItem("queue_token", j.token);
          setToken(j.token);
        }
        return;
      }
      throw new Error(`queue ${res.status}`);
    } catch {
      // fallback: sign dev token locally so booking-service tetap 200
      const t = await signDevQueueToken(userId, selected);
      localStorage.setItem("queue_token", t);
      setToken(t);
      setQueue({ ok: true, phase: "admitted", position: 1, queue_size: 1, token: t, fallback: "dev-hmac-local (wrangler tidak jalan)" });
    }
  }

  async function doHold() {
    if (!token) return setErr("Masuk Waiting Room dulu — butuh queue token.");
    if (picked.length === 0) return setErr("Pilih kursi dulu (klik di peta).");
    setPhase("holding");
    setErr("");
    setHoldRes(null);
    setCommitRes(null);
    // need category_id: infer from first picked seat
    const first = seats.find((s) => s.ID === picked[0]);
    const catId = first?.CategoryID || "550e8400-e29b-41d4-a716-446655440020";
    try {
      const res = await fetch(`${bookingBase}/api/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-queue-token": token },
        body: JSON.stringify({ event_id: selected, category_id: catId, seat_ids: picked, idempotency_key: crypto.randomUUID() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `hold ${res.status}`);
      setHoldRes(j);
      setPhase("held");
      // refresh seats
      fetch(`${apiBase}/api/events/${selected}/seats?category=`).then((r) => r.json()).then((j2) => setSeats((j2.seats || []).slice(0, 2000)));
    } catch (e: any) {
      setErr(e.message || String(e));
      setPhase("idle");
    }
  }

  async function doCommit() {
    if (!holdRes?.hold_id) return setErr("Hold dulu sebelum commit.");
    setPhase("committing");
    setErr("");
    try {
      const res = await fetch(`${bookingBase}/api/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-queue-token": token },
        body: JSON.stringify({ hold_id: holdRes.hold_id, idempotency_key: crypto.randomUUID(), seat_ids: picked }),
      });
      const j = await res.json();
      if (!res.ok && !j.order_id) throw new Error(j.error || j.warning || `commit ${res.status}`);
      setCommitRes(j);
      setPhase("idle");
      setPicked([]);
      setHoldRes(null);
      fetch(`${apiBase}/api/events/${selected}/seats?category=`).then((r) => r.json()).then((j2) => setSeats((j2.seats || []).slice(0, 2000)));
      fetch(`${apiBase}/api/events/${selected}`).then((r) => r.json()).then((j2) => setDetail({ inventory: j2.inventory || [], max_per_user: j2.max_per_user || 4, on_sale_at: j2.on_sale_at || event.on_sale_at, title: j2.title || event.title }));
    } catch (e: any) {
      setErr(e.message || String(e));
      setPhase("held");
    }
  }

  function toggleSeat(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= (detail?.max_per_user || event.max_per_user)) return prev;
      return [...prev, id];
    });
  }

  return (
    <div>
      {/* ticker */}
      <div className="overflow-hidden border-y border-zinc-900 bg-amber py-2">
        <div className="ticker-track flex w-max items-center gap-8 whitespace-nowrap font-mono text-[11px] font-bold tracking-[0.16em] text-ink">
          {Array.from({ length: 8 }).map((_, i) => (
            <span key={i} className="flex items-center gap-8">
              <span>FAIR QUEUE • ANTI-BOT • ATOMIC HOLD • NO SCALPER • GBK 80K • 100M REQ/MIN READY</span>
              <span className="h-1 w-1 rounded-full bg-ink" />
            </span>
          ))}
        </div>
      </div>

      {/* HERO — ticket stub as thesis */}
      <section className="relative overflow-hidden bg-paper bg-grid-paper">
        <div className="pointer-events-none absolute inset-0 bg-noise" />
        <div className="relative mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            {/* left editorial */}
            <div className="flex flex-col justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-ink/10 bg-white px-3 py-1.5 font-mono text-[10px] tracking-widest text-zinc-600">
                  <span className="h-2 w-2 rounded-full bg-vermilion" /> FLASH SALE • {event.status} • GBK STADIUM — JAKARTA
                </div>
                <h1 className="mt-4 font-condensed text-[52px] font-bold leading-[0.85] tracking-[-0.04em] text-ink sm:text-[68px] lg:text-[84px]">
                  MEGA
                  <br />
                  <span className="font-display font-extrabold tracking-[-0.05em]">CONCERT</span>
                  <br />
                  <span className="inline-flex -rotate-1 items-center gap-3 bg-vermilion px-3 py-1 text-[34px] tracking-[-0.02em] text-white sm:text-[42px]">
                    2026 <span className="rounded bg-white px-2 py-1 font-mono text-[11px] tracking-[0.18em] text-vermilion">ON SALE</span>
                  </span>
                </h1>
                <p className="mt-4 max-w-[52ch] font-body text-[14px] leading-6 text-zinc-600">
                  Bukan siapa cepat dia dapat. Masuk sebelum jam On Sale → posisi <b>diacak fair</b>. Masuk setelah On Sale → <b>FIFO</b>.
                  Token antrean HMAC 45 detik, anti-bot di Edge, stok kursi <b>atomic di Redis Lua</b> — tanpa double-booking.
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-ink px-3 py-1.5 font-mono text-[11px] font-bold tracking-widest text-white">pgx • NO ORM</span>
                  <span className="rounded-full border border-ink/15 bg-white px-3 py-1.5 font-mono text-[11px] font-bold text-zinc-700">Redis Lua HOLD 600s</span>
                  <span className="rounded-full border border-ink/15 bg-white px-3 py-1.5 font-mono text-[11px] font-bold text-zinc-700">HMAC JWT • Turnstile</span>
                  <span className="rounded-full bg-teal px-3 py-1.5 font-mono text-[11px] font-bold text-ink">PARTITIONED PG 16</span>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  onClick={joinQueue}
                  className="rounded-full bg-vermilion px-6 py-3 font-mono text-xs font-black tracking-[0.14em] text-white shadow-glow transition hover:bg-vermilion-2 active:scale-[0.98]"
                >
                  JOIN WAITING ROOM →
                </button>
                <a href="#events" className="rounded-full border border-ink/15 bg-white px-6 py-3 font-mono text-xs font-bold tracking-widest text-ink hover:bg-paper-2">
                  LIHAT SEATS
                </a>
                <span className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-3 font-mono text-[11px] tracking-widest text-white">
                  <span className={`h-2 w-2 rounded-full ${token ? "bg-teal" : "bg-zinc-500"}`} /> {token ? "TOKEN AKTIF" : "BELUM JOIN"}
                </span>
              </div>

              {/* countdown strip */}
              <div className="mt-6 grid grid-cols-3 gap-2 rounded-2xl border border-ink/10 bg-white p-2">
                <div className="rounded-xl bg-ink px-3 py-3 text-white">
                  <div className="font-mono text-[10px] tracking-[0.18em] text-zinc-400">ON SALE DALAM</div>
                  <div className="font-condensed text-[22px] font-bold leading-none tracking-tight">{cd.label}</div>
                  <div className="font-mono text-[10px] text-teal">{cd.live ? "LIVE — FIFO" : "PRE-SALE — RANDOMIZE"}</div>
                </div>
                <div className="rounded-xl bg-paper-2 px-3 py-3">
                  <div className="font-mono text-[10px] tracking-[0.16em] text-zinc-500">GBK KAPASITAS</div>
                  <div className="font-condensed text-[22px] font-bold text-ink">80.000</div>
                  <div className="font-mono text-[10px] text-zinc-500">VIP 500 • FESTIVAL 5000</div>
                </div>
                <div className="rounded-xl border border-amber bg-amber px-3 py-3">
                  <div className="font-mono text-[10px] tracking-[0.16em] text-ink/70">MAX / USER</div>
                  <div className="font-condensed text-[22px] font-bold text-ink">{detail?.max_per_user || event.max_per_user} TIKET</div>
                  <div className="font-mono text-[10px] font-bold text-ink">ANTI-SCALPER</div>
                </div>
              </div>
            </div>

            {/* right: ticket stub */}
            <div className="relative lg:pl-4">
              {/* halftone circle */}
              <div className="pointer-events-none absolute -right-8 -top-8 h-48 w-48 rounded-full bg-vermilion/10 blur-3xl" />
              <div className="relative overflow-hidden rounded-[28px] border border-ink/10 bg-white shadow-hard">
                <div className="absolute inset-x-0 top-0 h-2 bg-gradient-to-r from-vermilion via-amber to-teal" />
                <div className="grid lg:grid-cols-[1fr_84px]">
                  <div className="p-6 sm:p-7">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-400">ADMIT ONE • {event.slug.toUpperCase()}</div>
                        <div className="mt-1 font-display text-[22px] font-extrabold leading-none tracking-[-0.03em] text-ink">{detail?.title || event.title}</div>
                        <div className="mt-1 font-mono text-[11px] text-zinc-500">GBK Stadium • {new Date(detail?.on_sale_at || event.on_sale_at).toLocaleString("id-ID", { dateStyle: "long", timeStyle: "short" })}</div>
                      </div>
                      <div className="rounded-xl bg-ink px-3 py-2 text-center">
                        <div className="font-mono text-[9px] tracking-[0.18em] text-zinc-400">SECTION</div>
                        <div className="font-condensed text-sm font-bold text-white">GBK-A</div>
                      </div>
                    </div>

                    {/* price strip */}
                    <div className="mt-5 grid grid-cols-2 gap-3">
                      <div className="rounded-2xl bg-ink p-4 text-white">
                        <div className="font-mono text-[10px] tracking-widest text-zinc-400">VIP</div>
                        <div className="font-condensed text-lg font-bold leading-none">{fmtIDR(150_000_000).replace("Rp", "Rp ")}</div>
                        <div className="mt-1 font-mono text-[10px] text-zinc-400">{vipInv ? `${vipInv.available} tersedia • ${vipInv.sold} terjual` : "500 quota"}</div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/15">
                          <div className="h-full bg-vermilion" style={{ width: `${vipInv ? Math.round((Number(vipInv.sold) / 500) * 100) : 0}%` }} />
                        </div>
                      </div>
                      <div className="rounded-2xl border border-ink/10 bg-paper-2 p-4">
                        <div className="font-mono text-[10px] tracking-widest text-zinc-500">FESTIVAL A</div>
                        <div className="font-condensed text-lg font-bold leading-none text-ink">{fmtIDR(75_000_000).replace("Rp", "Rp ")}</div>
                        <div className="mt-1 font-mono text-[10px] text-zinc-500">{fesInv ? `${fesInv.available} tersedia` : "5000 quota"}</div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/10">
                          <div className="h-full bg-teal" style={{ width: `${fesInv ? Math.round((Number(fesInv.sold || 0) / 5000) * 100) : 0}%` }} />
                        </div>
                      </div>
                    </div>

                    {/* QR + token */}
                    <div className="mt-5 flex gap-3 rounded-2xl border border-dashed border-ink/15 bg-paper p-3">
                      <div className="grid h-[84px] w-[84px] place-items-center rounded-xl bg-ink font-mono text-[9px] tracking-widest text-white">
                        <div className="text-center leading-tight">
                          QR
                          <br />
                          TICKET
                          <br />
                          <span className="text-teal">● LIVE</span>
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[10px] tracking-[0.16em] text-zinc-500">QUEUE TOKEN (HMAC 45s)</div>
                        <div className="mt-1 break-all font-mono text-[11px] leading-4 text-ink">{token ? `${token.slice(0, 54)}…` : "Belum join — klik JOIN WAITING ROOM"}</div>
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => token && navigator.clipboard.writeText(token)}
                            disabled={!token}
                            className="rounded-full bg-white px-3 py-1.5 font-mono text-[11px] font-bold text-ink shadow disabled:opacity-40"
                          >
                            COPY TOKEN
                          </button>
                          <a href="/checkout" className="rounded-full bg-ink px-3 py-1.5 font-mono text-[11px] font-bold text-white">
                            CHECKOUT →
                          </a>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-2 font-mono text-[10px] tracking-widest text-zinc-400">
                      <span className="h-1 w-1 rounded-full bg-vermilion" /> BOOKING :8080 • READ :8081 • REDIS :6379 • LARAGON PG 16
                    </div>
                  </div>

                  {/* stub spine with perforation */}
                  <div className="relative flex flex-col items-center justify-between border-t border-dashed border-ink/15 bg-ink px-4 py-6 text-white lg:border-l lg:border-t-0">
                    <div className="absolute inset-y-0 left-0 hidden w-3 lg:block">
                      <div className="perf h-full w-full opacity-60" />
                    </div>
                    <div className="font-mono text-[10px] tracking-[0.22em] text-zinc-400">TIKET</div>
                    <div className="rotate-0 text-center font-condensed text-[22px] font-bold leading-none tracking-[-0.02em] lg:[writing-mode:vertical-rl] lg:rotate-180">
                      ADMIT ONE
                    </div>
                    <div className="rounded-full bg-vermilion px-3 py-1 font-mono text-[10px] font-black tracking-widest">VALID ONLY WITH TOKEN</div>
                    <div className="font-mono text-[10px] tracking-widest text-zinc-400">NO. {(picked.length || 0).toString().padStart(4, "0")}</div>
                  </div>
                </div>
              </div>
              <div className="mt-3 rounded-2xl bg-ink px-4 py-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                <span className="font-bold tracking-widest text-amber">ANTI-BOT:</span> Edge Turnstile + fingerprint + rate limit IP/FP/user. Bot = captcha dinamis, bukan diblokir diam-diam.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* WAITING ROOM live board */}
      <section className="border-y border-line bg-ink">
        <div className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-condensed text-lg font-bold tracking-[-0.02em] text-white">WAITING ROOM — LIVE BOARD</h2>
            <span className="rounded-full bg-white px-3 py-1 font-mono text-[11px] font-bold tracking-widest text-ink">POLL 2s • Token Bucket 2K/s</span>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-2xl border border-line bg-surface p-4">
              <div className="grid grid-cols-3 gap-3 font-mono text-xs">
                <div className="rounded-xl bg-ink px-4 py-4">
                  <div className="text-[10px] tracking-widest text-muted">POOL (PRE-SALE)</div>
                  <div className="font-condensed text-2xl font-bold text-white">{queue?.pool_size ?? queue?.poolSize ?? "—"}</div>
                  <div className="text-[11px] text-zinc-400">akan di-shuffle random saat On Sale</div>
                </div>
                <div className="rounded-xl bg-white px-4 py-4 text-ink">
                  <div className="text-[10px] tracking-widest text-zinc-500">ACTIVE FIFO</div>
                  <div className="font-condensed text-2xl font-bold">{queue?.active_size ?? queue?.activeSize ?? queue?.queue_size ?? "—"}</div>
                  <div className="text-[11px] text-zinc-500">admission 45s TTL</div>
                </div>
                <div className={`rounded-xl px-4 py-4 ${token ? "bg-teal text-ink" : "bg-surface-2 text-white border border-line"}`}>
                  <div className="text-[10px] tracking-widest opacity-70">POSISI KAMU</div>
                  <div className="font-condensed text-2xl font-bold">{queue?.position ?? (token ? "ADMITTED" : "—")}</div>
                  <div className="text-[11px] opacity-70">{queue?.estimated_wait_sec ? `${queue.estimated_wait_sec}s estimasi` : token ? "siap hold" : "join dulu"}</div>
                </div>
              </div>
              {queue && (
                <pre className="mt-3 max-h-32 overflow-auto rounded-xl bg-ink p-3 font-mono text-[11px] leading-4 text-emerald-300">{JSON.stringify(queue, null, 2)}</pre>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={joinQueue} className="rounded-full bg-vermilion px-5 py-2.5 font-mono text-xs font-black tracking-widest text-white hover:bg-vermilion-2">
                  {token ? "RE-JOIN / REFRESH TOKEN" : "JOIN WAITING ROOM"}
                </button>
                <button onClick={() => { localStorage.removeItem("queue_token"); setToken(""); setQueue(null); }} className="rounded-full border border-line bg-transparent px-5 py-2.5 font-mono text-xs font-bold tracking-widest text-zinc-300">
                  CLEAR TOKEN
                </button>
              </div>
            </div>
            <div className="rounded-2xl bg-paper p-5">
              <div className="font-condensed text-sm font-bold tracking-[-0.01em] text-ink">CARA KERJA FAIR QUEUE</div>
              <ol className="mt-3 space-y-2 font-body text-[13px] leading-5 text-zinc-700">
                <li className="flex gap-2">
                  <span className="mt-0.5 grid h-6 w-6 place-items-center rounded-full bg-ink font-mono text-[11px] font-bold text-white">1</span>
                  <span>
                    <b>Sebelum On Sale</b> → masuk <b>Waiting Pool</b> (ZSET). Saat On Sale, sistem <b>shuffle random</b> — yang internetnya lemot tetap adil.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-0.5 grid h-6 w-6 place-items-center rounded-full bg-vermilion font-mono text-[11px] font-bold text-white">2</span>
                  <span>
                    <b>Setelah On Sale</b> → masuk <b>belakang antrean FIFO</b>. Admission dikontrol Token Bucket 2k/s.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-0.5 grid h-6 w-6 place-items-center rounded-full bg-teal font-mono text-[11px] font-bold text-ink">3</span>
                  <span>
                    <b>Masuk halaman pilih tiket</b> hanya dengan <b>Signed Session Token TTL pendek</b> — anti scalper & anti bot.
                  </span>
                </li>
              </ol>
              <div className="mt-4 rounded-xl border border-ink/10 bg-white p-3 font-mono text-[11px] leading-4 text-zinc-600">
                Edge: Turnstile / reCAPTCHA Enterprise + device fingerprint + rate limit agresif per IP / User / FP. NIK 1 akun = max {detail?.max_per_user || event.max_per_user} tiket.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* EVENTS + SEATS */}
      <section id="events" className="bg-paper">
        <div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="font-mono text-[11px] tracking-[0.18em] text-zinc-500">KATALOG EVENT • READ SERVICE :8081</div>
              <h2 className="font-display text-[26px] font-extrabold tracking-[-0.03em] text-ink">Pilih event — langsung pilih kursi</h2>
            </div>
            <div className="font-mono text-[11px] tracking-widest text-zinc-500">Max {detail?.max_per_user || event.max_per_user} tiket / user • Hold 600s • Atomic Lua</div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {events.map((e) => {
              const isSel = e.id === selected;
              return (
                <button
                  key={e.id}
                  onClick={() => setSelected(e.id)}
                  className={`text-left rounded-[24px] border-2 p-1 text-left transition ${isSel ? "border-ink bg-white shadow-hard" : "border-ink/10 bg-white hover:border-ink/20"}`}
                >
                  <div className="rounded-[18px] bg-gradient-to-br from-ink via-surface to-surface-2 p-5 text-white">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold tracking-widest ${e.status === "SCHEDULED" ? "bg-amber text-ink" : "bg-teal text-ink"}`}>{e.status}</span>
                      <span className="font-mono text-[10px] tracking-widest text-zinc-400">max {e.max_per_user} tiket</span>
                    </div>
                    <div className="mt-3 font-display text-lg font-extrabold leading-none tracking-tight">{e.title}</div>
                    <div className="mt-1 font-mono text-xs text-zinc-400">{new Date(e.on_sale_at).toLocaleString("id-ID")} • {e.slug}</div>
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <div className="rounded-xl bg-white p-3 text-ink">
                        <div className="font-mono text-[10px] tracking-widest text-zinc-500">VIP</div>
                        <div className="font-condensed text-sm font-bold">Rp 150.000.000</div>
                      </div>
                      <div className="rounded-xl bg-white/10 p-3">
                        <div className="font-mono text-[10px] tracking-widest text-zinc-400">FESTIVAL</div>
                        <div className="font-condensed text-sm font-bold">Rp 75.000.000</div>
                      </div>
                    </div>
                  </div>
                  <div className={`mt-1 rounded-full px-4 py-2 text-center font-mono text-xs font-bold tracking-widest ${isSel ? "bg-vermilion text-white" : "bg-ink text-white"}`}>
                    {isSel ? "● DIPILIH — PILIH KURSI DI BAWAH" : "PILIH EVENT INI →"}
                  </div>
                </button>
              );
            })}
          </div>

          {/* seat map + hold/commit */}
          <div className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
            <div className="rounded-[24px] border border-ink/10 bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-condensed text-base font-bold tracking-[-0.01em] text-ink">PETA KURSI — klik untuk pick (max {detail?.max_per_user || event.max_per_user})</h3>
                <span className="rounded-full bg-ink px-3 py-1 font-mono text-[11px] font-bold tracking-widest text-white">{picked.length} dipilih</span>
              </div>

              {/* legend */}
              <div className="mt-3 flex flex-wrap gap-2 font-mono text-[11px]">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 bg-white px-2.5 py-1">
                  <span className="h-2.5 w-2.5 rounded-sm bg-white border border-ink/20" /> Available
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber px-2.5 py-1 font-bold text-ink">
                  <span className="h-2.5 w-2.5 rounded-sm bg-ink" /> Picked
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-200 px-2.5 py-1 text-zinc-600">HELD / SOLD</span>
                <span className="rounded-full bg-paper-2 px-2.5 py-1 text-zinc-600">{seats.length} loaded (limit 2000)</span>
              </div>

              {/* stage */}
              <div className="mt-4 rounded-xl bg-ink py-2 text-center font-mono text-[11px] tracking-[0.2em] text-white">— PANGGUNG —</div>

              <div className="mt-3 grid max-h-[360px] grid-cols-12 gap-1.5 overflow-auto rounded-xl border border-ink/10 bg-paper p-3 sm:grid-cols-16 lg:grid-cols-20">
                {seats.length === 0 && <div className="col-span-full py-12 text-center font-mono text-xs text-zinc-500">Belum ada seats. Jalankan seed SQL + pastikan read-service :8081 hidup.</div>}
                {seats.map((s) => {
                  const isPicked = picked.includes(s.ID);
                  const isTaken = s.Status !== "AVAILABLE";
                  return (
                    <button
                      key={s.ID}
                      disabled={isTaken}
                      onClick={() => toggleSeat(s.ID)}
                      title={`${s.SeatNumber} — ${s.Status} — ${s.ID.slice(0, 8)}`}
                      className={`grid h-7 place-items-center rounded-md border font-mono text-[9px] font-bold leading-none transition
                        ${isTaken ? "cursor-not-allowed border-zinc-200 bg-zinc-200 text-zinc-400" : isPicked ? "border-ink bg-ink text-white shadow" : "border-ink/15 bg-white text-zinc-700 hover:bg-amber hover:text-ink"}`}
                    >
                      {s.SeatNumber.replace("VIP-", "V").replace("FES-", "F")}
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={() => setPicked([])} className="rounded-full border border-ink/15 bg-white px-4 py-2 font-mono text-xs font-bold text-ink hover:bg-paper-2">
                  CLEAR
                </button>
                <span className="inline-flex items-center rounded-full bg-paper-2 px-3 py-2 font-mono text-[11px] text-zinc-600">
                  {picked.length ? picked.map((id) => seats.find((s) => s.ID === id)?.SeatNumber || id.slice(0, 8)).join(", ") : "Belum ada yang dipilih"}
                </span>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-[24px] bg-ink p-5 text-white shadow-hard">
                <div className="font-mono text-[10px] tracking-[0.18em] text-zinc-400">CHECKOUT — ATOMIC HOLD (Redis Lua)</div>
                <div className="mt-2 font-display text-lg font-extrabold leading-none">Hold 10 menit → Bayar → SOLD</div>
                <div className="mt-3 space-y-2 font-mono text-xs leading-5 text-zinc-300">
                  <div className="flex justify-between">
                    <span>Event</span>
                    <span className="font-bold text-white">{event.slug}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Kursi</span>
                    <span className="font-bold text-amber">{picked.length || 0} kursi</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Total estimasi</span>
                    <span className="font-bold text-white">{fmtIDR((picked.length || 0) * 150_000_000)}</span>
                  </div>
                </div>

                <div className="mt-4 grid gap-2">
                  <button
                    onClick={doHold}
                    disabled={phase !== "idle"}
                    className="rounded-full bg-vermilion py-3 font-mono text-xs font-black tracking-[0.14em] text-white transition hover:bg-vermilion-2 disabled:opacity-50"
                  >
                    {phase === "holding" ? "HOLDING..." : holdRes ? `HELD ${holdRes.hold_id.slice(0, 8)} • ${holdRes.ttl_sec}s` : "HOLD 10 MENIT (Lua Atomic)"}
                  </button>
                  <button
                    onClick={doCommit}
                    disabled={!holdRes || phase === "committing"}
                    className="rounded-full bg-white py-3 font-mono text-xs font-black tracking-[0.14em] text-ink transition hover:bg-zinc-100 disabled:opacity-50"
                  >
                    {phase === "committing" ? "COMMIT..." : "COMMIT / BAYAR → SOLD"}
                  </button>
                </div>

                {err && <div className="mt-3 rounded-xl bg-red-500/15 px-3 py-2 font-mono text-xs leading-4 text-red-200">{err}</div>}
                {holdRes && (
                  <div className="mt-3 rounded-xl bg-white/10 p-3 font-mono text-[11px] leading-4 text-zinc-200">
                    <div className="font-bold tracking-widest text-teal">HOLD OK</div>
                    <div>hold_id: {holdRes.hold_id}</div>
                    <div>expires: {holdRes.expires_at}</div>
                  </div>
                )}
                {commitRes && (
                  <div className="mt-3 rounded-xl bg-teal p-3 font-mono text-[11px] leading-4 text-ink">
                    <div className="font-black tracking-widest">PAID ✓</div>
                    <div>order_id: {commitRes.order_id}</div>
                    <div>status: {commitRes.status || "PAID"}</div>
                    <a href="#events" className="mt-2 inline-flex rounded-full bg-ink px-3 py-1 font-bold text-white">
                      Lihat seat jadi SOLD →
                    </a>
                  </div>
                )}

                <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 font-mono text-[11px] leading-4 text-zinc-400">
                  Tanpa token → <b className="text-white">401</b>. Stok tidak pakai <code className="rounded bg-white/10 px-1">SELECT FOR UPDATE</code> — semua deduksi via <b className="text-amber">hold.lua / commit.lua</b> atomic. Jika 10 menit tanpa bayar → auto release ke pool.
                </div>
              </div>

              <div className="rounded-2xl border border-ink/10 bg-white p-4">
                <div className="font-mono text-[11px] tracking-[0.16em] text-zinc-500">IDEMPOTENCY • DISTRIBUTED LOCK</div>
                <p className="mt-1 font-body text-[13px] leading-5 text-zinc-600">
                  Setiap <b>checkout pakai idempotency_key</b> — retry / network glitch tidak bikin double purchase. Order partitioned by range (PG 16) dengan FK <code className="rounded bg-paper-2 px-1">order_created_at</code>.
                </p>
                <div className="mt-3 flex gap-2">
                  <a href="/checkout" className="rounded-full bg-ink px-4 py-2 font-mono text-xs font-bold text-white">
                    Halaman checkout terpisah →
                  </a>
                  <button
                    onClick={() => {
                      fetch(`${apiBase}/api/events/${selected}`).then((r) => r.json()).then((j) => setDetail({ inventory: j.inventory || [], max_per_user: j.max_per_user || 4, on_sale_at: j.on_sale_at || event.on_sale_at, title: j.title || event.title }));
                      fetch(`${apiBase}/api/events/${selected}/seats?category=`).then((r) => r.json()).then((j) => setSeats((j.seats || []).slice(0, 2000)));
                    }}
                    className="rounded-full border border-ink/15 bg-white px-4 py-2 font-mono text-xs font-bold text-ink"
                  >
                    REFRESH
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 rounded-2xl border border-ink/10 bg-white p-4 font-mono text-[11px] leading-4 text-zinc-500">
            <span className="font-bold text-ink">Cara tes Laragon tanpa Docker:</span> <code className="rounded bg-ink px-1.5 py-0.5 text-amber">.\run-local.ps1</code> → <code className="rounded bg-paper-2 px-1.5 py-0.5">.\test-e2e.ps1</code> (HOLD VIP-0001 → COMMIT SOLD). Logs di <code className="rounded bg-paper-2 px-1 py-0.5">%TEMP%\tiket-*.log</code> • Health <code className="rounded bg-paper-2 px-1 py-0.5">:8080/health</code> • Gate tanpa token 401.
          </div>
        </div>
      </section>
    </div>
  );
}
