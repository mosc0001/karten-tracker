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
    // "gg" nur mit Abstand: "GG05" ist eine Kartennummer (Galarian Gallery), kein Prüfdienst
    "\\b(psa|bgs|cgc|gsg|sgc|tag|ace|aog|mnt|hga|pca|gma)\\s?-?\\s?\\d|\\bgg\\s-?\\s?\\d",
    "\\b(psa|bgs|cgc|beckett|gsg|sgc|aog|slab|slabbed|graded|gradata|gradee|bewertet|get graded)\\b",
  ].join("|")
);
/* ---------- Grading (PSA, CGC, BGS …) ---------- */
// Bekannte Prüfdienste: Kürzel und Schreibweisen in eBay-Titeln und im Merkmal "Professional Grader"
export const GRADERS = [
  { code: "PSA", label: "PSA", words: ["psa"], field: /psa|professional sports/ },
  { code: "CGC", label: "CGC", words: ["cgc"], field: /cgc|certified guaranty/ },
  { code: "BGS", label: "BGS (Beckett)", words: ["bgs", "beckett"], field: /bgs|beckett/ },
  { code: "SGC", label: "SGC", words: ["sgc"], field: /sgc|sportscard guaranty/ },
  { code: "TAG", label: "TAG", words: ["tag"], field: /\btag\b|technical authentication/ },
  { code: "ACE", label: "ACE", words: ["ace"], field: /\bace\b/ },
  { code: "GMA", label: "GMA", words: ["gma"], field: /\bgma\b/ },
  { code: "AGS", label: "AGS", words: ["ags"], field: /\bags\b/ },
  { code: "PCA", label: "PCA", words: ["pca"], field: /\bpca\b/ },
  { code: "GSG", label: "GSG", words: ["gsg"], field: /\bgsg\b/ },
  { code: "MNT", label: "MNT", words: ["mnt"], field: /\bmnt\b/ },
  { code: "HGA", label: "HGA", words: ["hga"], field: /\bhga\b/ },
];
// Grade eines Verkaufs für eine bestimmte Karte; bei einem nicht vorgesehenen Prüfdienst (eigene Angabe) neu lesen
function saleGradeFor(card, sale) {
  if (sale.gradeKey || !card.grader || GRADERS.some((g) => g.code === card.grader)) return { graded: sale.graded, key: sale.gradeKey };
  const g = parseGrade(sale.title || "", [card.grader]);
  return g && g.key ? { graded: true, key: g.key } : { graded: sale.graded, key: null };
}
const graderWords = (code) => (GRADERS.find((g) => g.code === code) || { words: [norm(code || "")] }).words.filter(Boolean);
const LABELS = { pristine: "Pristine", black: "Black Label", perfect: "Perfect" };
const labelOf = (t) => (/black\s?label/.test(t) ? "black" : /pristine/.test(t) ? "pristine" : /perfect/.test(t) ? "perfect" : null);
// Einheitlicher Schlüssel für den Vergleich: "PSA 9", "CGC 10 Pristine", "BGS 10 Black Label"
export function gradeKey(grader, grade, label) {
  if (!grader || grade == null || grade === "") return null;
  const g = Number(grade);
  return `${String(grader).toUpperCase()} ${Number.isInteger(g) ? g : g.toFixed(1)}${label && LABELS[label] ? " " + LABELS[label] : ""}`;
}
// Grade aus einem Text lesen. extraCodes: weitere Prüfdienste (eigene Angabe einer Karte, z. B. "MNT")
// Ergebnis: { grader, grade, label, key } | { uncertain: true } (z. B. "PSA 10 Kandidat") | null
export function parseGrade(text, extraCodes = []) {
  const t = norm(text);
  const list = [...GRADERS, ...extraCodes.filter((c) => c && !GRADERS.some((g) => g.code === c)).map((c) => ({ code: c, words: [norm(c)] }))];
  const found = [];
  for (const g of list) {
    for (const w of g.words) {
      const rx = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:grading|graded)?\\s*[-:#]?\\s*(?:(gem\\s?mint|gem\\s?mt|mint|pristine|black\\s?label|perfect)\\s*)?(10|[1-9](?:[.,]5)?)(?![\\d/.,]\\d)\\b(?:\\s*(pristine|black\\s?label|perfect))?`, "g");
      for (const m of t.matchAll(rx)) found.push({ grader: g.code, grade: Number(m[2].replace(",", ".")), label: labelOf(`${m[1] || ""} ${m[3] || ""}`) });
    }
  }
  if (!found.length) return null;
  if (/\b(kandidat|candidate|ready|worthy|potential|possible|moglich|mogliche|anwarter|tauglich|wurdig|chance)\b|\?/.test(t)) return { uncertain: true };
  const keys = new Set(found.map((f) => gradeKey(f.grader, f.grade, f.label)));
  if (keys.size > 1) {
    // gleiche Note mit und ohne Zusatz ("CGC 10 Pristine … CGC 10"): die genauere Angabe gilt
    const withLabel = found.filter((f) => f.label);
    const base = new Set(found.map((f) => gradeKey(f.grader, f.grade)));
    if (base.size === 1 && withLabel.length && new Set(withLabel.map((f) => f.label)).size === 1) return { ...withLabel[0], key: gradeKey(withLabel[0].grader, withLabel[0].grade, withLabel[0].label) };
    return { uncertain: true, conflict: true };
  }
  return { ...found[0], key: [...keys][0] };
}
// Grade aus den Merkmalen der Detailseite ("Professional Grader", "Grade", Zustand "Graded - PSA 10")
function gradeFromFields(sp, condRaw) {
  const graderTxt = norm(spec(sp, /^(professional grader|professioneller grader|grader|bewertungsfirma|prufdienst|gradingfirma)$/i));
  const gradeTxt = norm(spec(sp, /^(grade|note|bewertung)$/i));
  const g = GRADERS.find((x) => graderTxt && x.field.test(graderTxt));
  const num = gradeTxt.match(/\b(10|[1-9](?:[.,]5)?)\b/);
  if (g && num) return { grader: g.code, grade: Number(num[1].replace(",", ".")), label: labelOf(gradeTxt) };
  const fromCond = condRaw ? parseGrade(condRaw) : null;
  return fromCond && !fromCond.uncertain ? fromCond : null;
}

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
  if (/\b(japanese|japanisch|japan|jpn|jap|japon|japones|giapponese)\b/.test(t) || /\bJP\b/.test(title) || /[\u3040-\u30ff]/.test(title)) hits.add("JP");
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

/* ---------- Muster der Reverse-Holo-Folie (Poké Ball, Master Ball) ---------- */
// Seit Pokémon 151 gibt es in manchen Sets Reverse Holos mit Poké-Ball- bzw. Master-Ball-Muster, deutlich teurer
export const PATTERNS = { pokeball: "Poké Ball", masterball: "Master Ball" };
export function patternFromText(s) {
  const t = norm(s);
  if (/master ?ball|meisterball/.test(t)) return "masterball";
  if (/poke ?ball|pokeball|poke-ball|pokeball pattern/.test(t)) return "pokeball";
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

// Vorschaubild des Angebots (bleibt sichtbar, auch wenn das Angebot bei eBay verschwunden ist)
const EBAY_IMG = /^https:\/\/i\.ebayimg\.com\/[^\s"'<>]+$/;
function pickImage(row, detail) {
  const cands = [row && row.image, detail && Array.isArray(detail.images) && detail.images[0], detail && detail.image];
  for (const c of cands) if (typeof c === "string" && EBAY_IMG.test(c)) return c;
  return null;
}

/* ---------- Angenommener Preisvorschlag ---------- */
// eBay zeigt auf der Detailseite den gezahlten Betrag und daneben den durchgestrichenen Angebotspreis. Apify liefert
// den gezahlten Betrag im Feld taxExclusivePrice der Angebotsdaten (geprüft an sieben Angeboten aus DE, UK und USA,
// privat und gewerblich). Bei Angeboten in fremder Währung mit Einfuhrumsatzsteuer schlägt eBay 19 % auf "price" auf,
// taxExclusivePrice enthält sie nicht; das wird herausgerechnet. Ergebnis: Anteil des gezahlten Betrags am Angebotspreis.
// Angebote mit mehreren Varianten werden nicht ausgewertet. Bei Euro-Angeboten gewerblicher Händler, die nicht
// über einen Preisvorschlag verkauft wurden, steht im Feld der Nettopreis (Anteil 1/1,19): dann gilt der Wert als unklar.
export function offerRatio(detail) {
  const iv = detail && detail.vls && detail.vls.listing && detail.vls.listing.itemVariations;
  if (!Array.isArray(iv) || iv.length !== 1) return null;
  const ps = (iv[0] && iv[0].priceSettings) || {};
  const p = Number(ps.price && ps.price.value), t = Number(ps.taxExclusivePrice && ps.taxExclusivePrice.value);
  if (!(p > 0) || !(t > 0)) return null;
  if (ps.price.currency && ps.taxExclusivePrice.currency && ps.price.currency !== ps.taxExclusivePrice.currency) return null;
  const foreign = Boolean(ps.price.convertedFromCurrency) || (ps.exchangeRate && Number(ps.exchangeRate.value) !== 1);
  const r = t / (foreign && ps.includedVATInPrices ? p / 1.19 : p);
  if (!foreign && ps.includedVATInPrices && Math.abs(r - 1 / 1.19) < 0.002) return null;
  return r;
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

  // Grade (nur für bewertete Verkäufe von Belang)
  let gradeInfo = null;
  if (graded) {
    const fromTitle = parseGrade(title);
    const fromField = detail ? gradeFromFields(sp, condRaw) : null;
    if (fromTitle && !fromTitle.uncertain && fromField && gradeKey(fromField.grader, fromField.grade, fromTitle.label || fromField.label) !== fromTitle.key) {
      gradeInfo = { uncertain: true, conflict: true };
    } else if (fromTitle && !fromTitle.uncertain) gradeInfo = fromTitle;
    else if (fromField) gradeInfo = { ...fromField, key: gradeKey(fromField.grader, fromField.grade, fromField.label) };
    else gradeInfo = fromTitle; // null oder unsicher
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

  // Muster (Poké Ball / Master Ball): Titel und Merkmale
  const pattern = patternFromText(`${title} | ${featureText} | ${spec(sp, K.finish)}`);

  // Ausführung
  const finishField = spec(sp, K.finish);
  let finish = finishField ? finishFromText(finishField, true) : null;
  if (!finish) finish = finishFromText(featureText);
  if (!finish) finish = finishFromText(title);

  const askPrice = Number(row.priceValue ?? (detail && detail.priceValue));
  const format = row.buyingFormat || (detail && detail.buyingFormat) || null;
  // Preisvorschlag angenommen: Die Suche zeigt nur den Angebotspreis. Den gezahlten Betrag liefert die Detailseite.
  // Bei Auktionen ist der Preis immer das echte Höchstgebot.
  const bestOffer = format !== "auction" && Boolean(row.priceIsAskingPrice || row.bestOfferAccepted);
  let offerPrice = null;
  if (bestOffer && detail) {
    const r = offerRatio(detail);
    if (r != null && r >= 0.2 && r < 0.995) offerPrice = Math.round(askPrice * r * 100) / 100;
  }
  const price = offerPrice ?? askPrice;
  return {
    itemId: String(row.itemId),
    url: row.itemId ? `https://www.ebay.de/itm/${row.itemId}` : row.url || null,
    title,
    price,
    currency: row.currency || (detail && detail.currency) || "EUR",
    soldAt: row.soldAt ? new Date(row.soldAt).toISOString() : parseSoldAt(row, detail),
    format,
    // Preisvorschlag ohne bekannten Betrag: gezahlt wurde womöglich weniger als der Angebotspreis
    priceUncertain: bestOffer && offerPrice == null,
    // Preisvorschlag mit Betrag: price ist der gezahlte Betrag, askingPrice der durchgestrichene Angebotspreis
    offerPrice, askingPrice: offerPrice != null ? askPrice : null,
    offerChecked: bestOffer && Boolean(detail),
    hasDetail: Boolean(detail),
    graded, gradedReason,
    // Grade des Verkaufs: "PSA 9" usw.; null = nicht erkennbar; gradeUncertain bei "PSA 10 Kandidat" oder Widerspruch
    gradeKey: gradeInfo && gradeInfo.key ? gradeInfo.key : null,
    gradeUncertain: Boolean(gradeInfo && gradeInfo.uncertain),
    multi: MULTI_TITLE_RX.test(norm(title)) || new Set([...norm(title).matchAll(/\b(\d{1,3})\s*\/\s*\d{2,3}\b/g)].map((m) => Number(m[1]))).size > 1,
    stage, stageSource, language, edition, variant, reprint, finish, pattern, conflicts,
    image: pickImage(row, detail),
  };
}

/* ========================================================================
   matchCard: passende Verkäufe für eine Karte finden und auswerten
   card = { name, number, setTotal?, language: 'DE'|'EN'|'JP', condition: 'NM'|'LP'|'MP'|'HP',
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

// Kartennummern ohne "/Setgröße" im Titel: "#25", "Nr. 25", "No. 25", "Promo 25", "25 Promo", "(WP 25)".
// Bei Promo-Karten zählt auch eine alleinstehende Zahl ("Pikachu 27 Wizards Black Star Promos"),
// außer Jahreszahlen und Angaben wie "40 KP".
function looseNumbers(card, t) {
  const out = [];
  for (const m of t.matchAll(/(?:#|\bnr\.?|\bno\.?|\bnummer|\bpromos?)\s*0*(\d{1,3})\b|\b0*(\d{1,3})\s*promos?\b|\(\s*[a-z]{1,4}\s*0*(\d{1,3})\s*\)/g)) {
    out.push(Number(m[1] ?? m[2] ?? m[3]));
  }
  if (!out.length && isPromoSet(card.setName, card.setId)) {
    const t2 = t.replace(/\b\d+\s*(kp|hp|ps|pv|x)\b/g, " ").replace(/\b(19|20)\d\d\b/g, " ").replace(/\b\d+\s*x\b|\bx\s*\d+\b/g, " ");
    for (const m of t2.matchAll(/(?:^|[^a-z0-9])0*(\d{1,3})(?=$|[^a-z0-9])/g)) out.push(Number(m[1]));
  }
  return out;
}

// Gehört der Verkauf zu genau dieser Karte? Nummern mit Buchstaben (H3/H32) sind eine andere Karte als 3/147.
function relevant(card, sale) {
  const t = norm(sale.title);
  // Alte japanische Karten (bis Neo) haben keine aufgedruckte Nummer. "x/y" im Titel meint dann meist die
  // englische Entsprechung; zur Karte passt ein Verkauf hier über Namen und Set (die Suche enthält die Setbegriffe).
  if (card.language === "JP" && !card.number) return nameIn(card, t);
  const want = parseNumber(card.number);
  const toks = numberTokens(sale.title);
  if (toks.length) return ownNumberIn(card, toks);
  if (!want.prefix && Number.isFinite(want.num)) {
    const loose = looseNumbers(card, t);
    if (loose.length) return loose.includes(want.num) && nameIn(card, t);
  }
  // ohne "x/y": Buchstaben-Nummern wie "H29" allein im Titel
  const lone = [...t.matchAll(/\b([a-z]{1,5})\s?0*(\d{1,3})\b/g)].filter((m) => m[1] === want.prefix || (!want.prefix && m[1] === "h"));
  if (want.prefix) {
    if (lone.some((m) => m[1] === want.prefix && Number(m[2]) === want.num)) return true;
    if (lone.length) return false;
  } else if (lone.length) {
    return false; // Titel nennt eine Holo-Nummer (H..), deine Karte hat keine
  }
  return nameIn(card, t);
}

function nameIn(card, t) {
  const words = norm(card.name).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  if (!words.length) return t.includes(norm(card.name).trim()); // kurze Namen wie Ho-oh, Mew
  return words.some((w) => t.includes(w));
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
    // Japanische Karten tragen den englischen Namen; ein Namenstreffer sagt dort nichts über die Sprache
    r.language = card.language === "EN" || (nameHit && card.language !== "JP") ? "assumed" : "unknown";
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
  // Muster: Karten, die selbst "Poké Ball"/"Master Ball" heißen (Trainerkarten), nicht über den Titel prüfen
  const ballName = /ball/.test(norm(card.name));
  const salePattern = ballName ? null : sale.pattern;
  if (card.pattern) {
    // Ball-Muster gibt es nur als Reverse; ohne Nennung im Titel ist es meist die normale Version
    r.finish = salePattern === card.pattern ? "match" : salePattern ? "mismatch" : "unproven";
  } else if (salePattern && card.finish !== "holo") r.finish = "mismatch";
  // Zustand
  // Bewertete Karte: Statt des Zustands zählt der Grade (Prüfdienst, Note, Zusatz wie Pristine)
  if (card.graded) { const k = saleGradeFor(card, sale).key; r.condition = k ? (k === card.gradeKey ? "match" : "mismatch") : "unknown"; }
  else r.condition = sale.stage ? (sale.stage === card.condition ? "match" : "mismatch") : "unknown";
  return r;
}

function windowStats(sales, now, days) {
  const from = now - days * DAY;
  const v = sales.filter((s) => new Date(s.soldAt).getTime() >= from).map((s) => s.price);
  return { days, n: v.length, median: median(v), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
}

export function matchCard(card, sales, opts = {}) {
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const ex = { graded: 0, ungraded: 0, multi: 0, variant: 0, conflict: 0, irrelevant: 0, old: 0, other_currency: 0, duplicate: 0, no_date: 0 };
  const cands = [], conflictList = [], rejected = [];
  const reject = (s, reason) => rejected.push({ sale: s, reason });

  // Derselbe Verkauf kann mehrfach gespeichert sein: eBay rechnet Angebote in Fremdwährung bei jedem Abruf
  // leicht anders in Euro um. Ein Verkauf ist daher Artikelnummer + Verkaufstag, der Preis zählt nicht.
  // Von mehreren Fassungen gilt die mit gelesener Detailseite, sonst die zuerst gespeicherte.
  const best = new Map();
  for (const s of sales) {
    const key = saleKey(s);
    const prev = best.get(key);
    if (!prev) best.set(key, s);
    else { ex.duplicate++; if (s.hasDetail && !prev.hasDetail) best.set(key, s); }
  }
  for (const s of sales) {
    if (best.get(saleKey(s)) !== s) continue;
    if (!s.soldAt) { ex.no_date++; reject(s, "no_date"); continue; }
    if (now - new Date(s.soldAt).getTime() > 365 * DAY) { ex.old++; reject(s, "old"); continue; }
    if (s.currency !== "EUR") { ex.other_currency++; reject(s, "other_currency"); continue; }
    if (!relevant(card, s)) { ex.irrelevant++; reject(s, "irrelevant"); continue; }
    if (card.graded) {
      if (!saleGradeFor(card, s).graded) { ex.ungraded++; reject(s, "ungraded"); continue; }
    } else if (s.graded) { ex.graded++; reject(s, "graded"); continue; }
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
// Begriffe, die Verkäufer für die alten Sets tatsächlich in den Titel schreiben (deutsch und englisch).
// Schlüssel ist die TCGdex-Set-Kennung, sie ist in allen Sprachen gleich. Der TCGdex-Setname passt oft nicht
// zum Sprachgebrauch auf eBay (z. B. "Grundset" statt "Base Set", "Expedition Base Set" statt "Expedition").
// Mehrere Begriffe werden mit eBays Oder-Schreibweise verbunden: (A,B,C) = A oder B oder C im Titel.
export const SET_TERMS = {
  base1: ["Base", "Basis", "Grundset", "Basisset"],
  base2: ["Jungle", "Dschungel"],
  base3: ["Fossil"],
  base5: ["Rocket"],
  neo1: ["Genesis"],
  neo2: ["Discovery"],
  neo3: ["Revelation"],
  neo4: ["Destiny"],
  lc: ["Legendary"],
  ecard1: ["Expedition"],
  ecard2: ["Aquapolis"],
  ecard3: ["Skyridge"],
  "swsh12.5": ["Zenith", "Zenit", "CRZ"],
  "swsh12.5gg": ["Zenith", "Zenit", "CRZ"],
};

// Japanische Sets: englische Bezeichnung, Begriffe in eBay-Titeln, ob Kartennummern aufgedruckt sind.
// Schlüssel ist die TCGdex-Kennung der japanischen Sets (anders als bei den englischen, außer Neo).
export const JP_SETS = {
  PMCG1: { en: "Base Set (Expansion Pack)", terms: ["Base", "Expansion", "Basis", "Grundset"], noNumber: true },
  PMCG2: { en: "Jungle", terms: ["Jungle", "Dschungel"], noNumber: true },
  PMCG3: { en: "Fossil (Mystery of the Fossils)", terms: ["Fossil"], noNumber: true },
  PMCG4: { en: "Team Rocket (Rocket Gang)", terms: ["Rocket"], noNumber: true },
  PMCG5: { en: "Gym Heroes (Leaders' Stadium)", terms: ["Gym", "Leaders", "Stadium", "Heroes"], noNumber: true },
  PMCG6: { en: "Gym Challenge (Challenge from the Darkness)", terms: ["Gym", "Challenge", "Darkness"], noNumber: true },
  neo1: { en: "Neo Genesis (Gold, Silver, to a New World)", terms: ["Genesis"], noNumber: true },
  neo2: { en: "Neo Discovery (Crossing the Ruins)", terms: ["Discovery"], noNumber: true },
  neo3: { en: "Neo Revelation (Awakening Legends)", terms: ["Revelation"], noNumber: true },
  neo4: { en: "Neo Destiny (Darkness, and to Light)", terms: ["Destiny"], noNumber: true },
  E1: { en: "Base Expansion Pack (e-Series 1)", terms: ["Expedition", "Expansion", "ecard", "e-card"] },
  E2: { en: "The Town on No Map (e-Series 2)", terms: ["Aquapolis", "Town", "ecard", "e-card"] },
  E3: { en: "Wind from the Sea (e-Series 3)", terms: ["Aquapolis", "Wind", "ecard", "e-card"] },
  E4: { en: "Split Earth (e-Series 4)", terms: ["Skyridge", "Split", "ecard", "e-card"] },
  E5: { en: "Mysterious Mountains (e-Series 5)", terms: ["Skyridge", "Mysterious", "ecard", "e-card"] },
  VS1: { en: "Pokémon VS", terms: ["VS"] },
  web1: { en: "Pokémon Web", terms: ["Web"] },
  SM12a: { en: "Tag All Stars (SM12a)", terms: ["sm12a", "Allstars", "Stars"] },
  S4a: { en: "Shiny Star V (S4a)", terms: ["s4a", "Shiny"] },
  S8b: { en: "VMAX Climax (S8b)", terms: ["Climax", "s8b"] },
  S12a: { en: "VSTAR Universe (S12a)", terms: ["Universe", "s12a"] },
  SV2a: { en: "Pokémon Card 151 (SV2a)", terms: ["151", "sv2a"] },
  SV4a: { en: "Shiny Treasure ex (SV4a)", terms: ["sv4a", "Treasure"] },
  SV8a: { en: "Terastal Festival ex (SV8a)", terms: ["Terastal", "sv8a"] },
};
// Japanisch in eBay-Titeln (eBays Oder-Schreibweise)
const JP_WORDS = "(japanese,japanisch,japan,jpn,jp,jap)";

export function setIdOf(c) {
  return (c.tcg_meta && c.tcg_meta.setId) || (c.tcgdex_id ? String(c.tcgdex_id).replace(/-[^-]+$/, "") : null);
}

// Promo-Sets: Auf den Karten steht keine Setgröße, Verkäufer schreiben "Promo 4" oder "#4", nie "4/53"
const PROMO_SETS = new Set(["basep", "np", "dpp", "hgssp", "bwp", "xyp", "smp", "swshp", "svp"]);
export const isPromoSet = (setName, setId) => /promo/i.test(setName || "") || PROMO_SETS.has(setId || "") || /^[a-z]{1,3}-p$/i.test(setId || ""); // japanisch: SV-P, S-P, SM-P

// Schreibweisen der Kartennummer, wie Verkäufer sie in Titel schreiben: 6/62, 06/62, 006/062
export function numberVariants(number, setTotal) {
  const m = String(number ?? "").trim().match(/^0*(\d{1,3})$/);
  const t = Number(setTotal);
  if (!m || !Number.isInteger(t) || t < 1 || t > 999) return [];
  const n = Number(m[1]), ts = String(t);
  return [...new Set([`${n}/${t}`, `${String(n).padStart(2, "0")}/${t}`, `${String(n).padStart(ts.length, "0")}/${t}`,
    `${String(n).padStart(3, "0")}/${ts.padStart(3, "0")}`])];
}

const EXCLUDE = " -PSA -BGS -CGC -GSG -SGC -Beckett -graded -bewertet -slab -lot -bundle";

// Suche 1: Name + Setbegriffe. Findet auch Titel ohne Kartennummer (gemessen gut jeder siebte passende Verkauf).
// Bewertete Karten: Prüfdienst in die Suche, bewertete Angebote nicht ausschließen
const EXCLUDE_GRADED = " -lot -bundle -proxy";
const graderPart = (card) => {
  if (!card.grader) return "";
  const w = graderWords(card.grader);
  return w.length === 1 ? w[0].toUpperCase() : `(${w.join(",")})`;
};
const tail = (card) => (card.grader ? EXCLUDE_GRADED : EXCLUDE);

// Suchbegriff für Muster-Karten (statt "reverse": Verkäufer schreiben oft nur "Master Ball Holo")
const patternPart = (card) => card.pattern === "masterball" ? "(masterball,master)" : card.pattern === "pokeball" ? "(pokeball,poke,pokéball)" : "";
const finishPart = (card) => card.pattern ? patternPart(card) : card.finish === "reverse_holo" ? "reverse" : "";

export function buildQuery(card) {
  const jp = card.language === "JP";
  const terms = card.setId && ((jp && JP_SETS[card.setId] && JP_SETS[card.setId].terms) || SET_TERMS[card.setId]);
  // Japanische Setnamen (z. B. ポケモンカード151) stehen nicht in eBay-Titeln: ohne bekannte Begriffe kein Setteil
  const setPart = terms ? (terms.length === 1 ? terms[0] : `(${terms.join(",")})`) : (jp ? null : card.setName);
  // Reverse-Karten: gezielt nach "reverse" suchen, sonst sind die meisten bezahlten Zeilen normale Karten
  return [card.name, setPart, finishPart(card), jp ? JP_WORDS : "", graderPart(card)].filter(Boolean).join(" ") + tail(card);
}

// Suche 2: Name + Kartennummer. Trifft fast nur die eigene Karte und reicht dadurch viel weiter zurück
// (getestet: Haunter Fossil, 60 Treffer = 71 statt 33 Tage). Nicht für Promos und Nummern mit Buchstaben.
export function buildNumberQuery(card) {
  if (isPromoSet(card.setName, card.setId)) return null;
  let nums = numberVariants(card.number, card.setTotal);
  // Nummern mit Buchstaben aus Sondersets (Galarian Gallery GG05, Trainer Gallery TG12, Radiant Collection RC5):
  // Verkäufer schreiben sie meist allein ("GG05") oder mit Setgröße ("GG05/GG70")
  const pm = String(card.number || "").trim().match(/^([A-Za-z]{2,3})0*(\d{1,3})$/);
  if (!nums.length && pm && !/^(h|sv)$/i.test(pm[1])) {
    const pre = pm[1].toUpperCase(), n = pm[2];
    nums = [...new Set([`${pre}${n.padStart(2, "0")}`, `${pre}${n}`])];
  }
  if (!nums.length) return null;
  return [card.name, `(${nums.join(",")})`, finishPart(card), card.language === "JP" ? JP_WORDS : "", graderPart(card)].filter(Boolean).join(" ") + tail(card);
}

// Automatische Suchbegriffe einer Karte aus der Datenbank (Job und App nutzen dieselben). Beide Suchen laufen,
// die Ergebnisse werden zusammengeführt; doppelte Treffer erkennt der Job an der Artikelnummer.
export function autoQueries(c) {
  const card = { name: c.name, setName: c.set_name, setId: setIdOf(c), number: c.card_number, setTotal: c.set_total,
    finish: c.finish || (c.foil ? "holo" : "non_holo"), language: c.language, grader: c.grader && c.grade != null ? c.grader : null,
    pattern: c.tcg_meta && PATTERNS[c.tcg_meta.pattern] ? c.tcg_meta.pattern : null };
  const num = buildNumberQuery(card);
  // Japanische Karte aus einem Set ohne bekannte eBay-Begriffe: nur die Nummernsuche, "Name + japanisch" allein
  // brächte vor allem Verkäufe anderer Karten desselben Pokémon
  if (card.language === "JP" && num && !(JP_SETS[card.setId] || SET_TERMS[card.setId])) return [num];
  return [buildQuery(card), num].filter(Boolean);
}
export const autoQuery = (c) => autoQueries(c)[0];

// Vergleichsschlüssel für Suchbegriffe: Groß-/Kleinschreibung, Klammern, Kommas und Reihenfolge spielen keine Rolle.
// So werden Ergebnisse auch dann der richtigen Karte zugeordnet, wenn eBay den Suchbegriff leicht umformatiert zurückgibt.
export const queryKey = (q) => String(q || "").toLowerCase().replace(/[(),]/g, " ").split(/\s+/)
  .filter((t) => t && !t.startsWith("-")).sort().join(" ");

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
    setId: setIdOf(c),
    language: c.language,
    condition: c.condition,
    finish: c.finish || (c.foil ? "holo" : "non_holo"),
    firstEdition: Boolean(c.first_edition),
    variants: meta.variants || null,
    pattern: PATTERNS[meta.pattern] ? meta.pattern : null,
    graded: Boolean(c.grader && c.grade != null),
    grader: c.grader || null,
    gradeKey: gradeKey(c.grader, c.grade, c.grade_label),
  };
}

// Suchzeile + Detailseite -> Zeile für die Tabelle ebay_sales
export function toDbRow(cardId, sale, row) {
  const { itemId, title, url, price, soldAt, ...facts } = sale;
  return {
    card_id: cardId,
    item_id: itemId,
    sold_at: soldAt,
    price_eur: facts.askingPrice ?? price, // immer der Angebotspreis aus der Suche (Teil des Tabellenschlüssels)
    title,
    url: url || null,
    parsed: { ...facts, raw: { condition: row.condition ?? null, buyingFormat: row.buyingFormat ?? null, priceIsAskingPrice: Boolean(row.priceIsAskingPrice), bestOfferAccepted: Boolean(row.bestOfferAccepted) } },
  };
}

// Tabellenzeile -> Verkauf für matchCard
export function saleFromDb(r) {
  const { raw, ...facts } = r.parsed || {};
  if (!facts.finish) facts.finish = finishFromText(r.title || "");
  if (facts.format === "auction") facts.priceUncertain = false; // ältere Zeilen: Auktionspreis ist echt
  // Ältere Zeilen (vor der Grading-Erkennung gespeichert): Grade aus dem Titel nachlesen
  if (facts.graded && facts.gradeKey === undefined) {
    const g = parseGrade(r.title || "");
    facts.gradeKey = g && g.key ? g.key : null;
    facts.gradeUncertain = Boolean(g && g.uncertain);
  }
  // Von dir in der App gesetzter Zustand (Spalte stage_override) hat Vorrang vor der automatischen Erkennung
  if (STAGES.includes(r.stage_override)) {
    facts.stageAuto = facts.stage ?? null;
    facts.stage = r.stage_override;
    facts.stageSource = "manual";
    facts.conflicts = (facts.conflicts || []).filter((x) => x !== "condition");
  }
  let price = Number(r.price_eur);
  if (facts.offerPrice != null) { facts.askingPrice = price; price = Number(facts.offerPrice); facts.priceUncertain = false; }
  return { ...facts, itemId: r.item_id, title: r.title, url: r.url, price, soldAt: new Date(r.sold_at).toISOString(), currency: "EUR" };
}

// Suchzeile einer gespeicherten Zeile rekonstruieren (für nachträgliche Detailseiten)
export function rowFromDb(r) {
  const raw = (r.parsed && r.parsed.raw) || {};
  return { itemId: r.item_id, title: r.title, url: r.url, priceValue: Number(r.price_eur), currency: "EUR", soldAt: r.sold_at, condition: raw.condition, buyingFormat: raw.buyingFormat, priceIsAskingPrice: raw.priceIsAskingPrice, bestOfferAccepted: raw.bestOfferAccepted, image: (r.parsed && r.parsed.image) || null };
}

// Vorauswahl: lohnt sich eine Detailseite (kostet Geld)?  "drop" = nicht zur Karte, "ok" = reicht, "detail" = Detailseite holen
export function triage(card, sale) {
  if (!sale.soldAt || sale.currency !== "EUR") return "drop";
  if (!relevant(card, sale)) return "drop";
  if (sale.multi) return "drop";
  if (card.graded) {
    if (!saleGradeFor(card, sale).graded) return "drop";
  } else if (sale.graded && sale.gradedReason !== "search-condition") return "drop";
  if (sale.variant === "4th_print" || (sale.variant === "shadowless" && !card.firstEdition)) return "drop";
  if (sale.reprint && !norm(card.setName || "").includes(sale.reprint)) return "drop";
  if (sale.conflicts.length) return "drop";
  const c = check(card, sale);
  if (c.language === "mismatch" || c.edition === "mismatch" || c.finish === "mismatch") return "drop";
  if (card.graded) {
    // anderer Grade: für die Tabelle "Preise nach Grade" speichern, Detailseite unnötig
    if (c.condition === "mismatch" || sale.hasDetail) return "ok";
    return c.condition === "unknown" || c.language === "unknown" || c.finish === "unknown" || c.finish === "unproven" ||
      (card.firstEdition && c.edition !== "match") ? "detail" : "ok";
  }
  if (c.condition === "mismatch" && sale.stageSource === "title") return "drop";
  if (sale.hasDetail) return "ok";
  if (sale.priceUncertain) return "detail"; // Preisvorschlag: nur die Detailseite nennt den gezahlten Betrag
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

// Merkmale einer anderen gespeicherten Zeile desselben Angebots übernehmen (spart die Detailseite).
// Den Preisvorschlag als Anteil übertragen, weil der Euro-Betrag je Abruf leicht anders umgerechnet sein kann.
export function withSiblingFacts(sale, sib) {
  const { raw, offerPrice, askingPrice, ...facts } = sib || {};
  const out = { ...sale, ...facts };
  if (offerPrice != null && askingPrice > 0) {
    out.offerPrice = Math.round(sale.price * (offerPrice / askingPrice) * 100) / 100;
    out.askingPrice = sale.price;
    out.price = out.offerPrice;
    out.priceUncertain = false;
  } else { out.offerPrice = null; out.askingPrice = null; }
  return out;
}

// Ein Verkauf = Artikelnummer + Verkaufstag. Der Preis gehört nicht dazu, weil eBay Fremdwährungsangebote
// bei jedem Abruf etwas anders umrechnet (sonst würde derselbe Verkauf mehrfach gespeichert).
export const saleKey = (s) => `${s.itemId}|${String(s.soldAt || "").slice(0, 10)}`;
