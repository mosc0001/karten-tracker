// Nächtlicher Preisjob für den Karten-Tracker.
// Holt für jede Karte den Cardmarket-Trend über TCGdex und speichert ihn in Supabase.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL oder SUPABASE_SECRET_KEY fehlt (GitHub Secrets prüfen).");
  process.exit(1);
}

const base = SUPABASE_URL.replace(/\/$/, "");
const headers = { apikey: SUPABASE_KEY, "Content-Type": "application/json" };
// Alte JWT-Schlüssel (service_role) brauchen zusätzlich den Authorization-Header.
if (SUPABASE_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${SUPABASE_KEY}`;

const today = new Date().toISOString().slice(0, 10);

async function sb(path, init = {}) {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function tcgCard(lang, id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.tcgdex.net/v2/${lang}/cards/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// Gleiche Regel wie in der App: Holo-Felder ("-holo") nur bei Foil-Karten, die es auch ohne Holo gibt.
// Reine Holo-Karten haben ihren Preis in den normalen Feldern.
function priceFields(t, foil) {
  const m = t && t.pricing && t.pricing.cardmarket;
  if (!m) return null;
  const v = t.variants;
  const plainExists = v && typeof v === "object" ? v.normal === true : true;
  const num = (k) => typeof m[k] === "number";
  let suffix = foil && plainExists ? "-holo" : "";
  if (!num("trend" + suffix)) {
    const alt = suffix ? "" : "-holo";
    if (!num("trend" + alt)) return null;
    suffix = alt;
  }
  return { m, suffix };
}

const cards = await sb("cards?select=id,language,tcgdex_id,foil&tcgdex_id=not.is.null");
console.log(`${cards.length} Karten gefunden.`);

const rows = [];
let noPrice = 0;
let failed = 0;
const queue = [...cards];

async function worker() {
  while (queue.length) {
    const c = queue.shift();
    try {
      const t = await tcgCard(c.language.toLowerCase(), c.tcgdex_id);
      const f = priceFields(t, c.foil);
      if (!f) {
        noPrice++;
        continue;
      }
      const { m, suffix: s } = f;
      const trend = m["trend" + s];
      rows.push({
        card_id: c.id,
        captured_on: today,
        source: "cm_trend",
        price_eur: trend,
        details: {
          avg7: m["avg7" + s] ?? null,
          avg30: m["avg30" + s] ?? null,
          low: m["low" + s] ?? null,
          finish: s ? "foil" : "normal",
          updated: m.updated ?? null,
        },
      });
    } catch (e) {
      failed++;
      console.warn(`Fehler bei ${c.tcgdex_id} (${c.language}): ${e.message}`);
    }
  }
}

await Promise.all([worker(), worker(), worker(), worker()]);

for (let i = 0; i < rows.length; i += 200) {
  await sb("price_snapshots?on_conflict=card_id,captured_on,source", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows.slice(i, i + 200)),
  });
}

console.log(`Gespeichert: ${rows.length}, ohne Preis: ${noPrice}, Fehler: ${failed}.`);

// Bei überwiegend fehlgeschlagenen Abrufen soll GitHub eine Fehlermail schicken.
if (cards.length > 0 && failed > cards.length / 2) process.exit(1);
