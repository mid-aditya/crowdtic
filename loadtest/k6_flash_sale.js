// k6 — 100M req/min simulation (burst + fair queue + hold)
// Usage: k6 run --vus 5000 --duration 10m k6_flash_sale.js
// For 100M/min peak, run distributed: k6 cloud or partitioned VUs across injectors
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

export const options = {
  scenarios: {
    flash: {
      executor: 'ramping-arrival-rate',
      startRate: 5000, // req/s
      timeUnit: '1s',
      preAllocatedVUs: 2000,
      maxVUs: 20000,
      stages: [
        { target: 30000, duration: '30s' },  // ramp to 30k rps
        { target: 50000, duration: '60s' },  // peak 50k rps (~3M/min per injector; scale injectors for 100M)
        { target: 10000, duration: '120s' },
      ],
    },
  },
  thresholds: { http_req_failed: ['rate<0.05'], http_req_duration: ['p(95)<800','p(99)<1500'] },
};

const QUEUE_BASE = __ENV.QUEUE_BASE || 'http://localhost:8787';
const BOOKING_BASE = __ENV.BOOKING_BASE || 'http://localhost:8080';
const EVENT_ID = __ENV.EVENT_ID || '550e8400-e29b-41d4-a716-446655440010';
const CAT_ID = __ENV.CAT_ID || '550e8400-e29b-41d4-a716-446655440020';

const holdTrend = new Trend('hold_duration');
const soldCounter = new Counter('sold_total');

export default function () {
  const userId = `k6-${__VU}-${__ITER}-${Math.random().toString(36).slice(2,8)}`;
  // 1) Join queue
  let r = http.post(`${QUEUE_BASE}/queue/join`, JSON.stringify({ event_id: EVENT_ID, user_id: userId, fingerprint: `fp-${__VU}` }), { headers: { 'Content-Type':'application/json' }});
  check(r, { 'join 200': x=> x.status===200 });

  // 2) Poll status until admitted (token issued)
  let token = null;
  for (let i=0;i<8;i++) {
    let s = http.get(`${QUEUE_BASE}/queue/status?event_id=${EVENT_ID}&user_id=${userId}`);
    if (s.status===200) {
      const j = s.json();
      if (j.token) { token = j.token; break; }
    }
    sleep(0.5 + Math.random());
  }
  if (!token) return;

  // 3) Hold (atomic Lua) — random seat
  const seatNo = `VIP-${String(Math.floor(Math.random()*500)+1).padStart(4,'0')}`;
  // In real test, resolve seat uuid via /api/events/:id/seats
  const seatId = `00000000-0000-0000-0000-${String(Math.floor(Math.random()*1e12)).padStart(12,'0')}`; // placeholder; replace with real seed lookup
  const holdPayload = JSON.stringify({ event_id: EVENT_ID, category_id: CAT_ID, seat_ids: [seatId], idempotency_key: `${userId}-hold` });
  const t0 = Date.now();
  let h = http.post(`${BOOKING_BASE}/api/hold`, holdPayload, { headers: { 'Content-Type':'application/json', 'x-queue-token': token }});
  holdTrend.add(Date.now()-t0);
  if (h.status===201) {
    const hj = h.json();
    // 4) Commit
    let c = http.post(`${BOOKING_BASE}/api/commit`, JSON.stringify({ hold_id: hj.hold_id, idempotency_key: `${userId}-commit`, seat_ids: [seatId] }), { headers: { 'Content-Type':'application/json', 'x-queue-token': token }});
    if (c.status===200) soldCounter.add(1);
  }
  sleep(0.2);
}
