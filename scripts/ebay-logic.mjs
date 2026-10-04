// Karten-Tracker: Erkennung und Auswertung von eBay-Verkäufen.
// Reine Funktionen ohne Netzwerk. Wird vom Nachtjob und (inline) von der App genutzt.
//
// Ablauf:  parseSale(suchzeile, detailseite?)  ->  Merkmale eines Verkaufs
//          matchCard(karte, verkäufe)           ->  passende Verkäufe, Median je Zeitraum, Begründungen

const norm = (s) =>
  String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export const STAGES = ["NM", "LP", "MP", "HP"];
const DAY = 86400000;

/* ---------- Schlüsselnamen der Artikelmerkmale (eBay lokalisiert sie je nach Angebot) ---------- */
const K = {
  language: /^(language|sprache|lingua|langue|idioma|taal)$/i,
  finish: /^(finish|oberflachen?effekt|oberfl[aä]chen?effekt|finitura|finition|acabado|afwerking)$/i,
  features: /^(features|besonderheiten|caratteristiche|specialite|speciality|spécialité|caracteristiques|caracteristicas|kenmerken)$/i,
  edition: /^(edition|edizione|edicion)$/i,
  set: /^(set|erweiterung|espansione|extension|serie)$/i,
  cardCondition: /^(card condition|kartenzustand|condizione della carta|etat de la carte|état de la carte)$/i,
};

function spec(sp, rx) {
  for (const [k, v] of Object.entries(sp || {})) {
    if (rx.test(norm(k).trim()) || rx.test(String(k).trim())) return String(v ?? "");
  }
  return "";
}

/* ---------- Zustand ---------- */
// eBay-Stufen für ungradete Karten: NM = Near Mint or Better, LP = Lightly Played (Excellent),
// MP = Moderately Played (Very Good), HP = Heavily Played (Poor)
export function stagesIn(text) {
  const t = " " + norm(text).replace(/\b\d+\s*(hp|kp|ps)\b/g, " ") + " ";
  const found = new Set();
  if (/heavily played|stark bespielt|\bpoor\b|schlecht|\bhp\b|damaged|\bdmg\b|beschadigt|crease/.test(t)) found.add("HP");
  if (/moderately played|ma(ss|ß)ig bespielt|moderat|very good|sehr gut|\bvg\b|\bmp\b/.test(t)) found.add("MP");
  if (/lightly played|light play|leicht bespielt|exzellent|excellent|\bexc?\+?\b|\blp\+?\b/.test(t)) found.add("LP");
  if (/near mint|fast neuwertig|neuwertig|\bnm\b|\bmint\b/.test(t)) found.add("NM");
  return STAGES.filter((x) => found.has(x));
}

const UNGRADED_RX = /ungraded|nicht bewertet|non gradat|non gradee|non grade|sin graduar|no calificad|niet gegradeerd/;
const GRADED_COND_RX = /^(graded|bewertet|gradata|gradee|calificad|gegradeerd)/;
const GRADED_TITLE_RX = new RegExp(
  [
    "\\b(psa|bgs|cgc|gsg|sgc|tag|ace|aog|mnt|hga|pca|gma|gg)\\s?-?\\s?\\d",
    "\\b(psa|bgs|cgc|beckett|gsg|sgc|aog|slab|slabbed|graded|gradata|gradee|bewertet|get graded)\\b",
  ].join("|")
);
const MULTI_TITLE_RX = /\b(trio|big 3|you choose|choose|all \d+|alle \d+|lot|bundle|konvolut|sammlung|set of|\d+x|x\d+)\b/;

/* ---------- Sprache ---------- */
function langFromField(v) {
  const t = norm(v);
  if (/german|deutsch|allemand|tedesco|aleman/.test(t)) return "DE";
  if (/english|englisch|inglese|anglais|ingles/.test(t)) return "EN";
  if (/ital/.test(t)) return "IT";
  if (/fran[cz]|french|franz/.test(t)) return "FR";
  if (/japan|giapp/.test(t)) return "JP";
  if (/span|spagn|espan/.test(t)) return "ES";
  return t.trim() ? "OTHER" : null;
}

function langFromTitle(title) {
  const t = norm(title);
  const hits = new Set();
  if (/\b(deutsch|deutsche|german|germany)\b|\bger\b|\bbasis[- ]?set\b|\b\d+ ?kp\b/.test(t) || /\bDE\b/.test(title)) hits.add("DE");
  if (/\b(ita|italiano|italian|italiana|italienisch|edizione|prima edizione|carta|rara)\b|\bset base\b|\b\d+ ?ps\b/.test(t)) hits.add("IT");
  if (/\b(francais|french|franzosisch)\b/.test(t)) hits.add("FR");
  if (/\b(espanol|spanish|spanisch)\b/.test(t)) hits.add("ES");
  if (/\b(japanese|japanisch|japan|jpn|jap)\b/.test(t)) hits.add("JP");
  if (/\b(english|englisch)\b/.test(title.toLowerCase()) || /\bENG?\b/.test(title)) hits.add("EN");
  return hits.size === 1 ? [...hits][0] : null;
}

/* ---------- Edition, Druck, Ausführung ---------- */
const FIRST_RX = /\b1st\b|\b1\.? ?edition\b|first edition|erstausgabe|erstauflage|prima edizione|\b1 ?edizione|edizione 1|\b1(e|ere) edition|premiere edition|primera edicion|1a edizione/;
const UNLIMITED_RX = /\bunlimited\b|unlimitiert/;

function finishFromText(s, isField = false) {
  const t = norm(s);
  if (/reverse|\brevers\b|umgekehrt|\brev\.? ?holo|\brh\b|rev[- ]?foil/.test(t)) return "reverse_holo";
  if (/non[- ]?holo|nicht holo|no holo|ohne holo|non[- ]?foil|non olograf/.test(t)) return "non_holo";
  if (isField && /\b(regular|normal|standard)\b/.test(t)) return "non_holo";
  if (/\bholo(foil)?\b|olograf|holographic|\bfoil\b/.test(t)) return "holo";
  return null;
}

/* ---------- Datum ---------- */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseSoldAt(row, detail) {
  const m = String(row.soldDate ?? "").match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    return new Date(Date.UTC(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]), 12)).toISOString();
  }
  if (detail && detail.endDate && (detail.sold || detail.listingStatus === "ENDED")) return new Date(detail.endDate).toISOString();
  return null;
}

/* ========================================================================
   parseSale: aus einer Suchzeile (und, falls vorhanden, der Artikelseite) die Merkmale lesen
   ======================================================================== */
export function parseSale(row, detail = null) {
  const detailTitle = detail && (typeof detail.title === "string" ? detail.title : detail.title && detail.title.mainTitle);
  const title = String(row.title ?? detailTitle ?? "");
  const sp = (detail && detail.itemSpecifics) || {};
  const condRaw = detail && typeof detail.condition === "string" ? detail.condition : "";
  const condN = norm(condRaw);
  const conflicts = [];

  // bewertet / ungradet
  let graded = false;
  let gradedReason = null;
  if (GRADED_TITLE_RX.test(norm(title))) { graded = true; gradedReason = "title"; }
  if (condRaw) {
    if (UNGRADED_RX.test(condN)) {
      // Detailseite sagt ungradet, Titel nennt aber einen Prüfdienst: im Zweifel ausschließen
    } else if (GRADED_COND_RX.test(condN)) { graded = true; gradedReason = "condition"; }
  } else if (row.condition === "New (Other)") {
    graded = true; gradedReason = "search-condition"; // ohne Detailseite nicht bestätigt: ausschließen
  }

  // Zustand
  let stage = null, stageSource = null;
  if (condRaw) {
    const s = stagesIn(condRaw);
    if (s.length === 1) { stage = s[0]; stageSource = "field"; }
  }
  const cc = spec(sp, K.cardCondition);
  if (cc) {
    const s2 = stagesIn(cc);
    if (s2.length === 1) {
      if (stage && stage !== s2[0]) conflicts.push("condition");
      if (!stage) { stage = s2[0]; stageSource = "field"; }
    }
  }
  if (!stage) {
    const st = stagesIn(title);
    if (st.length === 1) { stage = st[0]; stageSource = "title"; }
  }

  // Sprache
  const langField = langFromField(spec(sp, K.language));
  const langTitle = langFromTitle(title);
  let language = langField || langTitle || null;
  if (langField && langTitle && langField !== langTitle && langField !== "OTHER") { conflicts.push("language"); language = null; }

  // Edition
  const featureText = [spec(sp, K.features), spec(sp, K.edition), spec(sp, K.set)].join(" | ");
  const fT = norm(title), fF = norm(featureText);
  const first = FIRST_RX.test(fT) || FIRST_RX.test(fF);
  const unlimited = UNLIMITED_RX.test(fT) || UNLIMITED_RX.test(fF);
  let edition = null;
  if (first && unlimited) { conflicts.push("edition"); }
  else if (first) edition = "1st";
  else if (unlimited) edition = "unlimited";

  // Druckvariante
  let variant = null;
  if (/4th print|4\.? ?druck|vierte auflage|fourth print/.test(norm(title + " " + featureText))) variant = "4th_print";
  else if (/shadowless|schattenlos/.test(norm(title + " " + featureText))) variant = "shadowless";

  // Neuauflage mit gleicher Kartennummer (Celebrations Classic Collection, Legendary Collection, Base Set 2)
  const rp = norm(title + " " + featureText).match(/classic collection|celebrations|25th anniversary|legendary collection|base set 2|basis[- ]?set 2/);
  const reprint = rp ? rp[0] : null;

  // Ausführung
  const finishField = spec(sp, K.finish);
  let finish = finishField ? finishFromText(finishField, true) : null;
  if (!finish) finish = finishFromText(featureText);
  if (!finish) finish = finishFromText(title);

  const price = Number(row.priceValue ?? (detail && detail.priceValue));
  return {
    itemId: String(row.itemId),
    url: row.itemId ? `https://www.ebay.de/itm/${row.itemId}` : row.url || null,
    title,
    price,
    currency: row.currency || (detail && detail.currency) || "EUR",
    soldAt: row.soldAt ? new Date(row.soldAt).toISOString() : parseSoldAt(row, detail),
    format: row.buyingFormat || (detail && detail.buyingFormat) || null,
    priceUncertain: Boolean(row.priceIsAskingPrice || row.bestOfferAccepted),
    hasDetail: Boolean(detail),
    graded, gradedReason,
    multi: MULTI_TITLE_RX.test(norm(title)) || new Set([...norm(title).matchAll(/\b(\d{1,3})\s*\/\s*\d{2,3}\b/g)].map((m) => Number(m[1]))).size > 1,
    stage, stageSource, language, edition, variant, reprint, finish, conflicts,
  };
}

/* ========================================================================
   matchCard: passende Verkäufe für eine Karte finden und auswerten
   card = { name, number, setTotal?, language: 'DE'|'EN', condition: 'NM'|'LP'|'MP'|'HP',
            finish: 'non_holo'|'holo'|'reverse_holo', firstEdition: boolean, variants?: {normal,holo,reverse} }
   ======================================================================== */
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Kartennummer zerlegen: "108" -> {prefix:"", num:108}, "H03" -> {prefix:"h", num:3}, "TG05" -> {prefix:"tg", num:5}
function parseNumber(n) {
  const m = String(n ?? "").trim().match(/^([A-Za-z]{0,5})\s*0*(\d+)/);
  return m ? { prefix: m[1].toLowerCase(), num: Number(m[2]) } : { prefix: "", num: NaN };
}

const numberTokens = (title) => [...norm(title).matchAll(/\b([a-z]{0,5})0*(\d{1,3})\s*\/\s*([a-z]{0,5})0*(\d{1,3})\b/g)]
  .map((m) => ({ pre: m[1], num: Number(m[2]), den: Number(m[4]) }));
const ownNumberIn = (card, toks) => {
  const want = parseNumber(card.number);
  return toks.some((k) => k.pre === want.prefix && k.num === want.num &&
    (want.prefix || !card.setTotal || k.den === Number(card.setTotal)));
};

// Gehört der Verkauf zu genau dieser Karte? Nummern mit Buchstaben (H3/H32) sind eine andere Karte als 3/147.
function relevant(card, sale) {
  const t = norm(sale.title);
  const want = parseNumber(card.number);
  const toks = numberTokens(sale.title);
  if (toks.length) return ownNumberIn(card, toks);
  // ohne "x/y": Buchstaben-Nummern wie "H29" allein im Titel
  const lone = [...t.matchAll(/\b([a-z]{1,5})\s?0*(\d{1,3})\b/g)].filter((m) => m[1] === want.prefix || (!want.prefix && m[1] === "h"));
  if (want.prefix) {
    if (lone.some((m) => m[1] === want.prefix && Number(m[2]) === want.num)) return true;
    if (lone.length) return false;
  } else if (lone.length) {
    return false; // Titel nennt eine Holo-Nummer (H..), deine Karte hat keine
  }
  const words = norm(card.name).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  return words.length > 0 && words.some((w) => t.includes(w));
}

function onlyFinish(card) {
  const v = card.variants;
  if (!v) return null;
  const f = [];
  if (v.normal) f.push("non_holo");
  if (v.holo) f.push("holo");
  if (v.reverse) f.push("reverse_holo");
  return f.length === 1 ? f[0] : null;
}

// Welche Ausführung zählt? Bei Reverse-Karten, die es unter dieser Nummer nicht als echte Holo gibt
// (z. B. Expedition 33-64), meint "Holo" im Titel oft die Reverse-Version. Das wird nur gewertet, wenn der Titel
// die eigene Kartennummer nennt: Ohne Nummer kann die echte Holo-Karte (andere Nummer, teurer) gemeint sein.
function effectiveFinish(card, sale) {
  if (sale.finish !== "holo" || card.finish !== "reverse_holo") return sale.finish || null;
  const v = card.variants;
  if (!v || v.holo !== false) return sale.finish;
  return ownNumberIn(card, numberTokens(sale.title)) ? "reverse_holo" : sale.finish;
}

function check(card, sale) {
  const r = {};
  // Sprache
  if (sale.language) r.language = sale.language === card.language ? "match" : "mismatch";
  else {
    const nameHit = norm(sale.title).includes(norm(card.name));
    r.language = card.language === "EN" || nameHit ? "assumed" : "unknown";
  }
  // Edition
  if (card.firstEdition) r.edition = sale.edition === "1st" ? "match" : sale.edition === "unlimited" ? "mismatch" : "unknown";
  else r.edition = sale.edition === "1st" ? "mismatch" : "match";
  // Ausführung. Reverse muss belegt sein (wie die 1st Edition): Ohne Angabe zählt ein Verkauf nicht,
  // denn wer eine Reverse Holo verkauft, schreibt das fast immer dazu. Bei normalen Karten gilt "ohne Angabe" als normal.
  const only = onlyFinish(card);
  const fin = effectiveFinish(card, sale);
  if (card.finish === "reverse_holo") r.finish = fin === "reverse_holo" ? "match" : fin ? "mismatch" : "unproven";
  else if (fin) r.finish = fin === card.finish ? "match" : "mismatch";
  else r.finish = only && only === card.finish ? "match" : "unknown";
  // Zustand
  r.condition = sale.stage ? (sale.stage === card.condition ? "match" : "mismatch") : "unknown";
  return r;
}

function windowStats(sales, now, days) {
  const from = now - days * DAY;
  const v = sales.filter((s) => new Date(s.soldAt).getTime() >= from).map((s) => s.price);
  return { days, n: v.length, median: median(v), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
}

export function matchCard(card, sales, opts = {}) {
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const ex = { graded: 0, multi: 0, variant: 0, conflict: 0, irrelevant: 0, old: 0, other_currency: 0, duplicate: 0, no_date: 0 };
  const seen = new Set();
  const cands = [], conflictList = [], rejected = [];
  const reject = (s, reason) => rejected.push({ sale: s, reason });

  for (const s of sales) {
    const key = `${s.itemId}|${(s.soldAt || "").slice(0, 10)}|${s.price}`;
    if (seen.has(key)) { ex.duplicate++; continue; }
    seen.add(key);
    if (!s.soldAt) { ex.no_date++; reject(s, "no_date"); continue; }
    if (now - new Date(s.soldAt).getTime() > 365 * DAY) { ex.old++; reject(s, "old"); continue; }
    if (s.currency !== "EUR") { ex.other_currency++; reject(s, "other_currency"); continue; }
    if (!relevant(card, s)) { ex.irrelevant++; reject(s, "irrelevant"); continue; }
    if (s.graded) { ex.graded++; reject(s, "graded"); continue; }
    if (s.multi) { ex.multi++; reject(s, "multi"); continue; }
    if (s.variant === "4th_print" || (s.variant === "shadowless" && !card.firstEdition)) { ex.variant++; reject(s, "variant"); continue; }
    if (s.reprint && !norm(card.setName || "").includes(s.reprint)) { ex.variant++; reject(s, "reprint"); continue; }
    if ((s.conflicts || []).length) { ex.conflict++; conflictList.push(s); reject(s, "conflict"); continue; }
    cands.push({ s, c: check(card, s) });
  }

  const mism = { language: 0, edition: 0, finish: 0, condition: 0, reverse_unproven: 0 };
  const strict = [], relaxed = [];
  for (const { s, c } of cands) {
    const vals = Object.values(c);
    if (c.language === "mismatch") mism.language++;
    else if (c.edition === "mismatch") mism.edition++;
    else if (c.finish === "mismatch") mism.finish++;
    else if (c.condition === "mismatch") mism.condition++;
    else if (c.finish === "unproven") mism.reverse_unproven++;
    const order = ["language", "edition", "finish", "condition"];
    if (vals.includes("mismatch")) { reject(s, order.find((k) => c[k] === "mismatch")); continue; }
    if (c.finish === "unproven") { reject(s, "reverse_unproven"); continue; }
    s.finishEff = effectiveFinish(card, s); // für die Anzeige: "Holo" mit eigener Nummer gilt als Reverse
    if (vals.every((v) => v === "match")) { strict.push(s); relaxed.push(s); continue; }
    // gelockert: Sprache und Ausführung dürfen angenommen sein, Edition (bei 1st) und Zustand nicht
    const okRelaxed = (c.language === "match" || c.language === "assumed") &&
      (c.finish === "match" || c.finish === "unknown") &&
      c.edition === "match" && c.condition === "match";
    if (okRelaxed) relaxed.push(s);
    else reject(s, "unknown_" + (order.find((k) => c[k] === "unknown") || "condition"));
  }

  // Kennzahl einer Menge: 90 Tage, wenn dort mindestens 3 Verkäufe liegen, sonst 12 Monate mit mindestens 3,
  // sonst das Fenster mit dem ersten vorhandenen Verkauf (der Wert wird dann angezeigt, zählt aber nicht im Gesamtwert).
  const evaluate = (set) => {
    const sorted = [...set].sort((x, y) => new Date(y.soldAt) - new Date(x.soldAt));
    const windows = { d30: windowStats(sorted, now, 30), d90: windowStats(sorted, now, 90), d365: windowStats(sorted, now, 365) };
    const pick = (w, label) => ({ value: w.median, basis: label, n: w.n });
    let headline = null;
    if (windows.d90.n >= 3) headline = pick(windows.d90, "90 Tage");
    else if (windows.d365.n >= 3) headline = pick(windows.d365, "12 Monate");
    else if (windows.d90.n >= 1) headline = pick(windows.d90, "90 Tage");
    else if (windows.d365.n >= 1) headline = pick(windows.d365, "12 Monate");
    const last5 = sorted.slice(0, 5).map((x) => x.price);
    return { sorted, windows, headline, last5: { n: last5.length, median: median(last5) } };
  };
  const evStrict = evaluate(strict), evRelaxed = evaluate(relaxed);
  let tier = "none", ev = evRelaxed, used = [];
  if (evStrict.headline && evStrict.headline.n >= 3) { tier = "strict"; ev = evStrict; used = evStrict.sorted; }
  else if (evRelaxed.headline) { tier = "relaxed"; ev = evRelaxed; used = evRelaxed.sorted; }
  const headline = tier === "none" ? null : ev.headline;
  const windows = ev.windows;
  const last5 = ev.last5;

  return {
    tier, used, strictN: strict.length, relaxedN: relaxed.length, candidates: cands.length,
    windows, last5, headline,
    countsTowardTotal: Boolean(headline && headline.n >= 3),
    uncertainN: used.filter((s) => s.priceUncertain).length,
    excluded: ex, mismatched: mism, conflicts: conflictList, rejected,
  };
}

// Suchbegriff für eBay: Name und Set, bewertete Karten und Sammelangebote werden schon bei eBay ausgeschlossen.
// Jede zurückgelieferte Zeile kostet Geld, deshalb lieber vorher aussortieren.
export function buildQuery(card) {
  // Reverse-Karten: gezielt nach "reverse" suchen, sonst sind die meisten bezahlten Zeilen normale Karten
  const base = [card.name, card.setName, card.finish === "reverse_holo" ? "reverse" : ""].filter(Boolean).join(" ");
  return base + " -PSA -BGS -CGC -GSG -SGC -Beckett -graded -bewertet -slab -lot -bundle";
}

/* ========================================================================
   Funktionen für den Nachtjob und die App
   ======================================================================== */

// Datenbankzeile einer Karte -> Karte für die Erkennung
export function cardFromRow(c) {
  const meta = c.tcg_meta || {};
  return {
    name: c.name,
    number: c.card_number,
    setTotal: c.set_total || null,
    setName: c.set_name || "",
    language: c.language,
    condition: c.condition,
    finish: c.finish || (c.foil ? "holo" : "non_holo"),
    firstEdition: Boolean(c.first_edition),
    variants: meta.variants || null,
  };
}

// Suchzeile + Detailseite -> Zeile für die Tabelle ebay_sales
export function toDbRow(cardId, sale, row) {
  const { itemId, title, url, price, soldAt, ...facts } = sale;
  return {
    card_id: cardId,
    item_id: itemId,
    sold_at: soldAt,
    price_eur: price,
    title,
    url: url || null,
    parsed: { ...facts, raw: { condition: row.condition ?? null, buyingFormat: row.buyingFormat ?? null, priceIsAskingPrice: Boolean(row.priceIsAskingPrice), bestOfferAccepted: Boolean(row.bestOfferAccepted) } },
  };
}

// Tabellenzeile -> Verkauf für matchCard
export function saleFromDb(r) {
  const { raw, ...facts } = r.parsed || {};
  if (!facts.finish) facts.finish = finishFromText(r.title || "");
  return { ...facts, itemId: r.item_id, title: r.title, url: r.url, price: Number(r.price_eur), soldAt: new Date(r.sold_at).toISOString(), currency: "EUR" };
}

// Suchzeile einer gespeicherten Zeile rekonstruieren (für nachträgliche Detailseiten)
export function rowFromDb(r) {
  const raw = (r.parsed && r.parsed.raw) || {};
  return { itemId: r.item_id, title: r.title, url: r.url, priceValue: Number(r.price_eur), currency: "EUR", soldAt: r.sold_at, condition: raw.condition, buyingFormat: raw.buyingFormat, priceIsAskingPrice: raw.priceIsAskingPrice, bestOfferAccepted: raw.bestOfferAccepted };
}

// Vorauswahl: lohnt sich eine Detailseite (kostet Geld)?  "drop" = nicht zur Karte, "ok" = reicht, "detail" = Detailseite holen
export function triage(card, sale) {
  if (!sale.soldAt || sale.currency !== "EUR") return "drop";
  if (!relevant(card, sale)) return "drop";
  if (sale.multi) return "drop";
  if (sale.graded && sale.gradedReason !== "search-condition") return "drop";
  if (sale.variant === "4th_print" || (sale.variant === "shadowless" && !card.firstEdition)) return "drop";
  if (sale.reprint && !norm(card.setName || "").includes(sale.reprint)) return "drop";
  if (sale.conflicts.length) return "drop";
  const c = check(card, sale);
  if (c.language === "mismatch" || c.edition === "mismatch" || c.finish === "mismatch") return "drop";
  if (c.condition === "mismatch" && sale.stageSource === "title") return "drop";
  if (sale.hasDetail) return "ok";
  const open = c.language !== "match" || c.condition !== "match" || c.finish === "unknown" || c.finish === "unproven" ||
    (card.firstEdition && c.edition !== "match") || sale.gradedReason === "search-condition";
  return open ? "detail" : "ok";
}

// Ergebnis -> Zeile für price_snapshots (Quelle ebay_sold)
export function snapshotPayload(r) {
  if (!r.headline) return null;
  const w = (x) => ({ n: x.n, median: x.median == null ? null : Math.round(x.median * 100) / 100 });
  return {
    price: Math.round(r.headline.value * 100) / 100,
    details: {
      n: r.headline.n, basis: r.headline.basis, tier: r.tier, counts: r.countsTowardTotal,
      strictN: r.strictN, relaxedN: r.relaxedN, uncertainN: r.uncertainN, conflicts: r.conflicts.length,
      windows: { d30: w(r.windows.d30), d90: w(r.windows.d90), d365: w(r.windows.d365) },
      last5: w(r.last5), excluded: r.excluded,
    },
  };
}

export const saleKey = (s) => `${s.itemId}|${String(s.soldAt || "").slice(0, 10)}|${s.price}`;
