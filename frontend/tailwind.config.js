/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#080B14",
        surface: "#111626",
        "surface-2": "#1B2235",
        line: "#232B45",
        paper: "#F5F1E8",
        "paper-2": "#EDE7DB",
        vermilion: "#FF2D17",
        "vermilion-2": "#FF5A45",
        amber: "#FFC82C",
        teal: "#0ED3B9",
        muted: "#8B95B5",
      },
      fontFamily: {
        display: ["var(--font-syne)", "sans-serif"],
        body: ["var(--font-inter)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
        condensed: ["var(--font-oswald)", "sans-serif"],
      },
      boxShadow: {
        "hard": "0 20px 60px -20px rgba(0,0,0,0.6)",
        "glow": "0 0 40px rgba(255,45,23,0.35)",
      },
      backgroundImage: {
        "grid-paper": "linear-gradient(to right, rgba(11,15,26,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(11,15,26,0.06) 1px, transparent 1px)",
        "noise": "radial-gradient(ellipse at top, rgba(255,45,23,0.12), transparent 60%), radial-gradient(ellipse at bottom right, rgba(14,211,185,0.08), transparent 50%)",
      }
    },
  },
  plugins: [],
};
