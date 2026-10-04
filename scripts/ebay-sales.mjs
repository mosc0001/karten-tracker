// Karten-Tracker: eBay-Verkäufe abfragen, auswerten und als Preis speichern.
//
// Ablauf pro Durchlauf:
//   1. Karten laden, fehlende TCGdex-Angaben (Kartenanzahl des Sets, Ausführungen) nachtragen
//   2. Fällige Karten nach Wert sortieren und innerhalb der Budgetgrenzen auswählen
//   3. Eine gebündelte Suche bei Apify (alle Karten in einem Lauf)
//   4. Detailseiten nur für Treffer, bei denen Zustand oder Sprache im Titel fehlen
//   5. Verkäufe speichern, dann für ALLE Karten den Wert neu berechnen (auch ohne neue Abfrage)

import {
  parseSale, matchCard, buildQuery, cardFromRow, toDbRow, saleFromDb, rowFromDb, triage, snapshotPayload, saleKey, queryKey, setIdOf,
} from "./ebay-logic.mjs";

const env = process.env;
const num = (v, d) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);
const DAY = 86400000;

const CFG = {
  supabaseUrl: (env.SUPABASE_URL || "").replace(/\/$/, ""),
  supabaseKey: env.SUPABASE_SECRET_KEY || "",
  apifyToken: env.APIFY_TOKEN || "",
  actor: env.EBAY_ACTOR || "memo23~ebay-search-scraper-ppe",
  runBudget: num(env.EBAY_RUN_BUDGET_USD, 1.2),       // höchstens so viel pro Durchlauf (Schätzung)
  monthBudget: num(env.EBAY_MONTH_BUDGET_USD, 4.0),   // höchstens so viel pro Monat (Schätzung)
  topN: num(env.EBAY_TOP_N, 15),                      // die wertvollsten Karten ...
  topEveryDays: num(env.EBAY_TOP_EVERY_DAYS, 7),      // ... werden so oft abgefragt
  restEveryDays: num(env.EBAY_REST_EVERY_DAYS, 28),   // alle übrigen so oft
  backfillRows: num(env.EBAY_BACKFILL_ROWS, 60),      // Zeilen je Karte beim ersten Laden
  updateRows: num(env.EBAY_UPDATE_ROWS, 15),          // Zeilen je Karte bei Aktualisierungen
  maxDetailPages: num(env.EBAY_MAX_DETAIL_PAGES, 150),
  pollMs: num(env.EBAY_POLL_MS, 5000),
  pollMaxMs: num(env.EBAY_POLL_MAX_MS, 25 * 60 * 1000),
};

// Kosten in Dollar, aus den Testläufen geschätzt (siehe Anleitung)
const COST = { searchRun: 0.01, searchUrl: 0.016, searchRow: 0.0031, detailRun: 0.027, detailPage: 0.0045 };

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round(n * 100) / 100;

// Statusmeldung für die App (Tabelle app_status, ab update6.sql).
// Ein Fehler hier darf den Job nie stoppen: Ohne Tabelle wird nur ein Hinweis protokolliert.
async function writeStatus(patch) {
  try {
    const old = await sb("app_status?select=value&key=eq.ebay_job");
    const prev = (old && old[0] && old[0].value) || {};
    await sb("app_status?on_conflict=key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ key: "ebay_job", value: { ...prev, ...patch }, updated_at: new Date().toISOString() }]),
    });
  } catch (e) {
    log("Hinweis: Status für die App nicht gespeichert (update6.sql ausgeführt?): " + String(e.message).slice(0, 160));
  }
}

if (!CFG.supabaseUrl || !CFG.supabaseKey) {
  console.error("SUPABASE_URL oder SUPABASE_SECRET_KEY fehlt (GitHub Secrets prüfen).");
  process.exit(1);
}

/* ---------- Supabase ---------- */
const sbHeaders = { apikey: CFG.supabaseKey, "Content-Type": "application/json" };
if (CFG.supabaseKey.startsWith("eyJ")) sbHeaders.Authorization = `Bearer ${CFG.supabaseKey}`;

async function sb(path, init = {}) {
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/${path}`, { ...init, headers: { ...sbHeaders, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`Supabase ${res.status} bei ${path.split("?")[0]}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sbAll(path, pageSize = 1000) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await sb(`${path}${path.includes("?") ? "&" : "?"}limit=${pageSize}&offset=${offset}`);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

async function upsert(table, rows, conflict, chunk = 200) {
  for (let i = 0; i < rows.length; i += chunk) {
    await sb(`${table}?on_conflict=${conflict}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + chunk)),
    });
  }
}

/* ---------- Apify ---------- */
async function apify(path, init = {}) {
  const res = await fetch(`https://api.apify.com/v2${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CFG.apifyToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// capUsd: harte Kostengrenze bei Apify für Dienste mit Abrechnung pro Ereignis, falls die Schätzung danebenliegt
async function runActor(input, label, capUsd) {
  const cap = capUsd > 0 ? `?maxTotalChargeUsd=${Math.max(0.05, capUsd).toFixed(2)}` : "";
  const start = await apify(`/acts/${CFG.actor}/runs${cap}`, { method: "POST", body: JSON.stringify(input) });
  let run = start.data;
  const t0 = Date.now();
  while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
    if (Date.now() - t0 > CFG.pollMaxMs) throw new Error(`${label}: Zeitüberschreitung`);
    await sleep(CFG.pollMs);
    run = (await apify(`/actor-runs/${run.id}`)).data;
  }
  if (run.status !== "SUCCEEDED") throw new Error(`${label}: Lauf endete mit ${run.status}`);
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await apify(`/datasets/${run.defaultDatasetId}/items?format=json&limit=1000&offset=${offset}`);
    items.push(...page);
    if (page.length < 1000) break;
  }
  return { items, usd: typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null };
}

const proxy = { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "DE" };
const searchUrl = (q) => `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(q).replace(/%20/g, "+")}&LH_Sold=1&LH_Complete=1&_sop=13`;
const qKey = queryKey;
const queryOf = (card) => (card.ebay_query && card.ebay_query.trim()) ||
  buildQuery({ name: card.name, setName: card.set_name, setId: setIdOf(card), finish: card.finish || (card.foil ? "holo" : "non_holo") });

function rowQuery(r) {
  const skw = (r.basic_info && r.basic_info.skw) || null;
  if (skw) return qKey(skw);
  const m = String(r.url || "").match(/[?&]_skw=([^&]+)/);
  return m ? qKey(decodeURIComponent(m[1].replace(/\+/g, " "))) : null;
}

async function pool(n, items, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}

/* ======================================================================== */
async function main() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const stats = { cards: 0, searchRows: 0, urls: 0, searchRuns: 0, detailPages: 0, detailRuns: 0, apifyUsd: 0, apifyUsdKnown: false, failed: 0, ok: 0 };

  /* 1. Karten und Hilfswerte */
  const cards = await sbAll("cards?select=id,name,set_name,card_number,language,condition,finish,foil,first_edition,quantity,tcgdex_id,ebay_query,set_total,tcg_meta,ebay_checked_at&order=created_at");
  log(`${cards.length} Karten.`);

  // Kartenanzahl und Ausführungen von TCGdex nachtragen (kostenlos)
  const needMeta = cards.filter((c) => c.tcgdex_id && !c.tcg_meta).slice(0, 80);
  await pool(4, needMeta, async (c) => {
    try {
      const res = await fetch(`https://api.tcgdex.net/v2/${c.language.toLowerCase()}/cards/${encodeURIComponent(c.tcgdex_id)}`);
      if (!res.ok) return;
      const t = await res.json();
      const patch = {
        set_total: (t.set && t.set.cardCount && t.set.cardCount.official) || null,
        tcg_meta: { variants: t.variants || null, setId: (t.set && t.set.id) || null },
      };
      await sb(`cards?id=eq.${c.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      Object.assign(c, patch);
    } catch (e) { /* nächste Runde */ }
  });

  // Reihenfolge nach bisherigem Wert (Cardmarket-Trend als Näherung, bis eBay-Werte vorliegen)
  const latest = await sbAll("card_latest_prices?select=card_id,source,price_eur,details");
  const valueOf = new Map(), hadEbay = new Set();
  for (const r of latest) {
    const none = r.details && r.details.none;
    if (r.source === "ebay_sold" && !none) { valueOf.set(r.card_id, Number(r.price_eur)); hadEbay.add(r.card_id); }
    else if (r.source === "cm_trend" && !valueOf.has(r.card_id)) valueOf.set(r.card_id, Number(r.price_eur));
  }
  const worth = (c) => (valueOf.get(c.id) || 0) * (c.quantity || 1);
  const ranked = [...cards].sort((a, b) => worth(b) - worth(a));

  /* 2. Budget und Auswahl */
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  let runsThisMonth;
  try {
    runsThisMonth = await sb(`ebay_runs?select=est_cost_usd,apify_cost_usd&started_at=gte.${monthStart}`);
  } catch (e) {
    throw new Error("Tabelle ebay_runs nicht lesbar. Wurde update5.sql in Supabase ausgeführt? " + e.message);
  }
  const spent = runsThisMonth.reduce((s, r) => s + Math.max(Number(r.est_cost_usd || 0), Number(r.apify_cost_usd || 0)), 0);
  const available = Math.max(0, Math.min(CFG.runBudget, CFG.monthBudget - spent));
  log(`Budget: Monat ${CFG.monthBudget.toFixed(2)} $, bisher ${spent.toFixed(2)} $, dieser Lauf höchstens ${available.toFixed(2)} $.`);

  const estBackfill = COST.searchUrl + CFG.backfillRows * COST.searchRow + 0.5 * CFG.backfillRows * COST.detailPage;
  const estUpdate = COST.searchUrl + CFG.updateRows * COST.searchRow + 0.25 * CFG.updateRows * COST.detailPage;
  let budget = available - 2 * COST.searchRun - COST.detailRun;
  const backfill = [], update = [];
  const isDue = (c, i) => !c.ebay_checked_at || now - new Date(c.ebay_checked_at) > (i < CFG.topN ? CFG.topEveryDays : CFG.restEveryDays) * DAY;
  const dueTotal = ranked.filter(isDue).length;
  if (CFG.apifyToken && budget > 0) {
    ranked.forEach((c, i) => {
      const every = i < CFG.topN ? CFG.topEveryDays : CFG.restEveryDays;
      const due = !c.ebay_checked_at || now - new Date(c.ebay_checked_at) > every * DAY;
      if (!due) return;
      const est = c.ebay_checked_at ? estUpdate : estBackfill;
      if (est > budget) return;
      budget -= est;
      (c.ebay_checked_at ? update : backfill).push(c);
    });
  } else if (!CFG.apifyToken) {
    log("APIFY_TOKEN fehlt: Es wird nur neu gerechnet, nichts abgefragt.");
  } else {
    log("Kein Budget mehr frei: Es wird nur neu gerechnet.");
  }
  log(`Fällig und im Budget: ${backfill.length} zum ersten Laden, ${update.length} zum Aktualisieren.`);

  /* 3. Gebündelte Suche je Gruppe */
  const searchRowsByCard = new Map(); // cardId -> Suchzeilen
  for (const [group, rows, label] of [[backfill, CFG.backfillRows, "Erstladen"], [update, CFG.updateRows, "Aktualisierung"]]) {
    if (!group.length) continue;
    const byQ = new Map();
    for (const c of group) { const q = queryOf(c); const k = qKey(q); if (!byQ.has(k)) byQ.set(k, { q, cards: [] }); byQ.get(k).cards.push(c); }
    const urls = [...byQ.values()].map((x) => ({ url: searchUrl(x.q) }));
    try {
      log(`${label}: ${urls.length} Suchen in einem Lauf (je ${rows} Zeilen) ...`);
      const spentSoFar = stats.searchRuns * COST.searchRun + stats.urls * COST.searchUrl + stats.searchRows * COST.searchRow;
      const { items, usd } = await runActor({ startUrls: urls, marketplace: "ebay.de", detailedItems: false, maxItems: rows, proxy }, label, available - spentSoFar);
      stats.searchRuns++; stats.urls += urls.length;
      if (usd !== null) { stats.apifyUsd += usd; stats.apifyUsdKnown = true; }
      const rowsByQ = new Map();
      for (const it of items) {
        if (it._analytics || !it.itemId) continue;
        stats.searchRows++;
        const k = rowQuery(it);
        if (!k) continue;
        if (!rowsByQ.has(k)) rowsByQ.set(k, []);
        rowsByQ.get(k).push(it);
      }
      for (const [k, x] of byQ) for (const c of x.cards) { searchRowsByCard.set(c.id, rowsByQ.get(k) || []); stats.cards++; }
      stats.ok++;
    } catch (e) {
      console.error(`${label} fehlgeschlagen: ${e.message}`);
      stats.failed++;
    }
  }

  /* 4. Neue Verkäufe, Vorauswahl, Detailseiten */
  const processed = ranked.filter((c) => searchRowsByCard.has(c.id));
  const existing = new Map(); // cardId -> Map(key -> Tabellenzeile)
  if (processed.length) {
    const ids = processed.map((c) => c.id).join(",");
    for (const r of await sbAll(`ebay_sales?select=card_id,item_id,sold_at,price_eur,title,url,parsed&card_id=in.(${ids})&order=id`)) {
      if (!existing.has(r.card_id)) existing.set(r.card_id, new Map());
      existing.get(r.card_id).set(saleKey(saleFromDb(r)), r);
    }
  }

  const work = []; // { card, engineCard, row, sale, existingRow?, need: 'ok'|'detail' }
  for (const c of processed) {
    const ec = cardFromRow(c);
    const have = existing.get(c.id) || new Map();
    const seen = new Set();
    for (const row of searchRowsByCard.get(c.id)) {
      const sale = parseSale(row);
      if (!sale.soldAt) continue;
      const key = saleKey(sale);
      if (have.has(key) || seen.has(key)) continue;
      seen.add(key);
      work.push({ card: c, ec, row, sale, need: triage(ec, sale) });
    }
    // gespeicherte Zeilen ohne Detailseite, die eine brauchen (frühere Läufe waren zu knapp)
    for (const r of have.values()) {
      const p = r.parsed || {};
      if (p.hasDetail || p.detailTried) continue;
      const row = rowFromDb(r);
      const sale = parseSale(row);
      if (triage(ec, sale) === "detail") work.push({ card: c, ec, row, sale, need: "detail", upgrade: true });
    }
  }

  // Detailseiten: jede Artikelnummer nur einmal, vorhandene Ergebnisse anderer Karten wiederverwenden
  const wantItems = [...new Set(work.filter((w) => w.need === "detail").map((w) => w.sale.itemId))];
  const siblings = new Map(); // itemId -> parsed mit Detailseite
  if (wantItems.length) {
    for (let i = 0; i < wantItems.length; i += 80) {
      const part = wantItems.slice(i, i + 80);
      for (const r of await sbAll(`ebay_sales?select=item_id,parsed&item_id=in.(${part.join(",")})&order=id`)) {
        if (r.parsed && r.parsed.hasDetail && !siblings.has(r.item_id)) siblings.set(r.item_id, r.parsed);
      }
    }
  }
  let toFetch = wantItems.filter((id) => !siblings.has(id));
  const pageBudget = Math.max(0, Math.floor((available - 0.04 - stats.searchRuns * COST.searchRun - stats.urls * COST.searchUrl - stats.searchRows * COST.searchRow - COST.detailRun) / COST.detailPage));
  const cap = Math.max(0, Math.min(CFG.maxDetailPages, pageBudget));
  if (toFetch.length > cap) { log(`Detailseiten: ${toFetch.length} gewünscht, ${cap} im Budget. Der Rest folgt beim nächsten Lauf.`); toFetch = toFetch.slice(0, cap); }

  const details = new Map();
  if (toFetch.length && CFG.apifyToken) {
    try {
      log(`Detailseiten: ${toFetch.length} Artikel in einem Lauf ...`);
      const { items, usd } = await runActor({
        startUrls: toFetch.map((id) => ({ url: `https://www.ebay.de/itm/${id}` })),
        marketplace: "ebay.de", detailedItems: true, maxItems: toFetch.length, proxy,
      }, "Detailseiten", COST.detailRun + toFetch.length * COST.detailPage * 1.5);
      stats.detailRuns++; stats.detailPages += toFetch.length;
      if (usd !== null) { stats.apifyUsd += usd; stats.apifyUsdKnown = true; }
      for (const it of items) if (it.itemId) details.set(String(it.itemId), it);
      stats.ok++;
    } catch (e) {
      console.error(`Detailseiten fehlgeschlagen: ${e.message}`);
      stats.failed++;
    }
  }
  const attempted = new Set(stats.detailRuns ? toFetch : []);

  /* 5. Speichern */
  const out = new Map();
  for (const w of work) {
    let sale;
    const sib = siblings.get(w.sale.itemId);
    if (w.need === "detail" && sib) {
      const { raw, ...facts } = sib;
      sale = { ...w.sale, ...facts };
    } else if (w.need === "detail" && details.has(w.sale.itemId)) {
      sale = parseSale(w.row, details.get(w.sale.itemId));
    } else {
      sale = w.sale;
      if (w.need === "detail" && attempted.has(w.sale.itemId)) sale.detailTried = true;
    }
    if (w.upgrade && !sale.hasDetail && !sale.detailTried) continue; // nichts Neues erfahren
    const dbRow = toDbRow(w.card.id, sale, w.row);
    out.set(`${dbRow.card_id}|${saleKey(sale)}`, dbRow);
  }
  if (out.size) await upsert("ebay_sales", [...out.values()], "card_id,item_id,sold_at,price_eur");
  log(`${out.size} Verkäufe gespeichert oder aktualisiert.`);

  if (processed.length) {
    for (let i = 0; i < processed.length; i += 20) {
      const part = processed.slice(i, i + 20).map((c) => c.id).join(",");
      await sb(`cards?id=in.(${part})`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ebay_checked_at: now.toISOString() }) });
    }
  }

  /* 6. Für ALLE Karten neu rechnen (auch das Herausrutschen alter Verkäufe aus dem Zeitfenster) */
  const allSales = await sbAll("ebay_sales?select=card_id,item_id,sold_at,price_eur,title,url,parsed&excluded=eq.false&order=id");
  const byCard = new Map();
  for (const r of allSales) { if (!byCard.has(r.card_id)) byCard.set(r.card_id, []); byCard.get(r.card_id).push(saleFromDb(r)); }
  const snaps = [];
  let withValue = 0, counted = 0;
  for (const c of cards) {
    const res = matchCard(cardFromRow(c), byCard.get(c.id) || [], { now });
    const snap = snapshotPayload(res);
    if (!snap) {
      if (hadEbay.has(c.id)) snaps.push({ card_id: c.id, captured_on: today, source: "ebay_sold", price_eur: 0, details: { none: true, n: 0, counts: false } });
      continue;
    }
    withValue++;
    if (snap.details.counts) counted++;
    snaps.push({ card_id: c.id, captured_on: today, source: "ebay_sold", price_eur: snap.price, details: snap.details });
  }
  if (snaps.length) await upsert("price_snapshots", snaps, "card_id,captured_on,source");
  log(`Werte berechnet: ${withValue} Karten mit eBay-Wert, davon ${counted} mit mindestens 3 Verkäufen (zählen im Gesamtwert).`);

  /* 7. Protokoll */
  const est = (stats.searchRuns ? stats.searchRuns * COST.searchRun + stats.urls * COST.searchUrl + stats.searchRows * COST.searchRow : 0) +
    (stats.detailRuns ? COST.detailRun + stats.detailPages * COST.detailPage : 0);
  if (stats.searchRuns || stats.detailRuns || stats.failed) {
    await sb("ebay_runs", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        cards: stats.cards, rows: stats.searchRows, detail_pages: stats.detailPages,
        est_cost_usd: Math.round(est * 1000) / 1000,
        apify_cost_usd: stats.apifyUsdKnown ? Math.round(stats.apifyUsd * 1000) / 1000 : null,
        note: stats.failed ? `${stats.failed} Lauf/Läufe fehlgeschlagen` : null,
      }),
    });
  }
  log(`Geschätzte Kosten dieses Durchlaufs: ${est.toFixed(2)} $${stats.apifyUsdKnown ? `, laut Apify ${stats.apifyUsd.toFixed(3)} $` : ""}.`);
  const done = new Set(processed.map((c) => c.id));
  const hardFail = Boolean(stats.failed && !stats.ok);
  await writeStatus({
    at: new Date().toISOString(),
    ok: !hardFail,
    partial: stats.failed > 0 && !hardFail,
    message: stats.failed ? `${stats.failed} Apify-Lauf/Läufe fehlgeschlagen` : null,
    loaded: backfill.length,
    updated: update.length,
    waiting: Math.max(0, dueTotal - backfill.length - update.length),
    neverLoaded: cards.filter((c) => !c.ebay_checked_at && !done.has(c.id)).length,
    monthSpent: round2(spent + est),
    monthBudget: CFG.monthBudget,
    month: monthStart.slice(0, 7),
    tokenMissing: !CFG.apifyToken,
    withValue, counted,
    ...(hardFail ? {} : { lastSuccessAt: new Date().toISOString() }),
  });
  if (hardFail) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await writeStatus({ at: new Date().toISOString(), ok: false, partial: false, message: String((e && e.message) || e).slice(0, 300) });
  process.exit(1);
});
