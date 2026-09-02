import "./globals.css";
import { Syne, Inter, JetBrains_Mono, Oswald } from "next/font/google";

const syne = Syne({ subsets: ["latin"], weight: ["700", "800"], variable: "--font-syne" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });
const oswald = Oswald({ subsets: ["latin"], weight: ["500", "700"], variable: "--font-oswald" });

export const metadata = {
  title: "TIKET — Mega Concert Flash Sale",
  description: "High-concurrency fair queue ticketing — anti-bot, atomic hold, FCFS sebenar",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className={`${syne.variable} ${inter.variable} ${mono.variable} ${oswald.variable}`}>
      <body className="min-h-screen bg-ink text-zinc-100 antialiased selection:bg-vermilion selection:text-white">
        {/* top system bar */}
        <div className="sticky top-0 z-50 border-b border-line/80 bg-ink/85 backdrop-blur supports-[backdrop-filter]:bg-ink/70">
          <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-vermilion font-condensed text-[11px] font-bold tracking-[0.18em] text-white shadow-glow">
                TKT
              </div>
              <div className="leading-none">
                <div className="font-display text-[15px] font-extrabold tracking-[-0.02em]">TIKET<span className="text-vermilion">.</span></div>
                <div className="font-mono text-[10px] tracking-[0.16em] text-muted">MEGA PLATFORM • GBK</div>
              </div>
              <span className="hidden items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[10px] font-semibold tracking-widest text-zinc-300 sm:inline-flex">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" /> LIVE QUEUE
              </span>
            </div>
            <nav className="hidden items-center gap-6 font-mono text-[11px] tracking-widest text-muted md:flex">
              <span className="text-zinc-200">FLASH SALE</span>
              <span> очереди fair</span>
              <span className="rounded-full bg-white px-3 py-1 font-bold tracking-normal text-ink">Edge • Turnstile • HMAC</span>
            </nav>
            <div className="flex items-center gap-2">
              <a href="#events" className="hidden rounded-full bg-vermilion px-4 py-2 font-mono text-xs font-bold tracking-widest text-white hover:bg-vermilion-2 sm:inline-flex">
                LIHAT EVENT
              </a>
              <div className="hidden h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-xs sm:flex">ID</div>
            </div>
          </div>
        </div>
        <div className="bg-paper text-ink">
          <main className="mx-auto max-w-[1280px]">{children}</main>
        </div>
        <footer className="border-t border-line bg-ink py-8">
          <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 px-4 text-[11px] font-mono tracking-widest text-muted sm:px-6 lg:px-8">
            <span>© 2026 TIKET — pgx • go-redis Lua • NATS • pg 16 partitioned</span>
            <span className="text-zinc-500">Laragon local: :8080 booking • :8081 read • :6379 redis</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
