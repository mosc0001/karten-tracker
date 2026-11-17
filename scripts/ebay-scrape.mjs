/* Eigener Abruf der eBay-Suche "Verkaufte Artikel" (ersetzt den Apify-Suchlauf).
   Läuft nur von einem normalen Internetanschluss aus: eBay sperrt Rechenzentren (GitHub-Server bekommen 403).
   Liefert Zeilen im selben Format wie der bisherige Apify-Dienst (memo23/ebay-search-scraper-ppe), damit die
   übrige Logik unverändert bleibt. Kein Umgehen von Sperren: Bei 403 oder Prüfseite bricht der Abruf ab und
   meldet "blocked"; der Job nimmt dann wie bisher Apify.

   Höflich: eine Anfrage nach der anderen mit Pause dazwischen (EBAY_OWN_DELAY_MS, Standard 2,5 s). */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9,en;q=0.7",
};

export class BlockedError extends Error {}

const DE_MONTHS = { jan: 0, feb: 1, mär: 2, mar: 2, apr: 3, mai: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dez: 11 };
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function text(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

// "EUR 1.234,56" -> 1234.56 (bei Spannen "EUR 10,00 bis EUR 20,00" der erste Preis)
function priceOf(s) {
  const m = String(s).match(/(EUR|€)\s*([\d.]+,\d{2}|[\d.]+)/);
  if (!m) return null;
  const n = Number(m[2].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// "Verkauft 15. Nov 2026" -> ISO, Mittag UTC wie bisher
function soldAtOf(s) {
  const m = String(s).match(/Verkauft\s+(\d{1,2})\.\s*([A-Za-zä]{3})[a-zä]*\.?\s+(\d{4})/i);
  if (!m) return null;
  const mon = DE_MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[1]), 12)).toISOString();
}

// Zustandswort der Suche in die Begriffe des bisherigen Dienstes übersetzen ("New (Other)" heißt dort: meist bewertet)
function conditionOf(s) {
  const t = String(s).toLowerCase();
  if (/neu\s*\(sonstige\)|neu\s*[–-]\s*sonstige|new \(other\)/.test(t)) return "New (Other)";
  if (/^\s*(brandneu|neu|new|brand new)\b/.test(t)) return "Brand New";
  if (/gebraucht|pre-owned|used/.test(t)) return "Pre-Owned";
  return null;
}

// eBay lässt Anführungszeichen bei Attributen mit nur einem Wert weg: class=s-card__title und class="a s-card__title"
const cls = (name) => `class=(?:"[^"]*\\b${name}\\b[^"]*"|${name}(?=[\\s>]))[^>]*>`;
const RX = {
  caption: new RegExp(`${cls("s-card__caption")}([\\s\\S]*?)</div>`),
  title: new RegExp(`${cls("s-card__title")}([\\s\\S]*?)</div>`),
  price: new RegExp(`${cls("s-card__price")}([\\s\\S]*?)</span>`),
  attr: new RegExp(`${cls("s-card__attribute-row")}([\\s\\S]*?)</div>`, "g"),
  sub: new RegExp(`${cls("s-card__subtitle")}([\\s\\S]*?)</div>`, "g"),
};

/* Eine Suchseite in Zeilen zerlegen. q: Suchbegriff (wird als basic_info.skw mitgegeben, darüber ordnet der Job
   die Zeilen der Karte zu). Ergebnisse "für weniger Suchbegriffe" kommen mit (_rewrite: true), wie beim Dienst. */
export function parseSearchHtml(html, q) {
  const rewriteAt = html.search(/srp-river-answer--REWRITE_START/);
  const parts = html.split(/<li\b(?=[^>]*\bclass="?s-(?:card|item)\b)/);
  const rows = [];
  let pos = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    const li = parts[i];
    const start = pos;
    pos += li.length + 3;
    const idm = li.match(/data-listingid="?(\d{9,15})\b/) || li.match(/\/itm\/(\d{9,15})/);
    if (!idm) continue;
    const capM = li.match(RX.caption);
    const soldAt = capM ? soldAtOf(text(capM[1])) : null;
    if (!soldAt) continue; // Werbung, Platzhalter
    const titleM = li.match(RX.title);
    let title = titleM ? text(titleM[1].replace(/<span class="?clipped"?>[\s\S]*?<\/span>/g, "")) : "";
    title = title.replace(/^Neues Angebot\s*/i, "").replace(/\s*Wird in neuem Fenster oder Tab geöffnet\s*$/i, "").trim();
    const priceM = li.match(RX.price);
    const priceValue = priceM ? priceOf(text(priceM[1])) : null;
    if (!title || priceValue == null) continue;
    // Zeilen unter dem Preis: Gebote, Preisvorschlag, Versand, Herkunft
    const attrs = [...li.matchAll(RX.attr)].map((m) => text(m[1]));
    const subs = [...li.matchAll(RX.sub)].map((m) => text(m[1]));
    const offer = attrs.some((a) => /Preisvorschlag (akzeptiert|angenommen)/i.test(a));
    const bids = attrs.find((a) => /^\d[\d.]*\s+Gebot(e)?$/i.test(a));
    const loc = attrs.find((a) => /^aus\s+\S/i.test(a));
    const condLine = subs.find((s) => conditionOf(s.split("|")[0])) || "";
    // großes Vorschaubild (data-defer-load, s-l500) vor dem kleinen Platzhalter (src, s-l140)
    const imgM = li.match(/data-defer-load="?(https:\/\/i\.ebayimg\.com\/[^"\s>]+)/) || li.match(/<img[^>]+\bsrc="?(https:\/\/i\.ebayimg\.com\/[^"\s>]+)/);
    const itemId = idm[1];
    rows.push({
      itemId,
      title,
      priceValue,
      currency: "EUR",
      soldAt,
      url: `https://www.ebay.de/itm/${itemId}`,
      image: imgM ? imgM[1] : null,
      condition: conditionOf(condLine.split("|")[0]),
      // Auktion mit angenommenem Preisvorschlag (Sofort-Kaufen-Option) zählt wie ein Preisvorschlag
      buyingFormat: bids && !offer ? "auction" : "fixed_price",
      bidCount: bids ? Number(bids.replace(/\D/g, "")) : null,
      bestOfferAccepted: offer,
      priceIsAskingPrice: offer,
      itemLocation: loc || null,
      basic_info: { skw: q },
      _rewrite: rewriteAt >= 0 && start > rewriteAt,
      _source: "own",
    });
  }
  return rows;
}

export const searchUrlFor = (q, ipg = 240, page = 1) =>
  `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(q).replace(/%20/g, "+")}&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=${ipg}${page > 1 ? `&_pgn=${page}` : ""}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHtml(url, tries = 2) {
  for (let t = 0; ; t++) {
    let res;
    try {
      res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(30000) });
    } catch (e) {
      if (t + 1 < tries) { await sleep(5000); continue; }
      throw e;
    }
    const html = await res.text();
    // Sperre oder Prüfseite: sofort aufhören, nicht umgehen
    if (res.status === 403 || res.status === 429 || /splashui\/challenge|Pardon Our Interruption/i.test(res.url + html.slice(0, 5000))) {
      throw new BlockedError(`eBay blockiert (${res.status}${/challenge/.test(res.url) ? ", Prüfseite" : ""})`);
    }
    if (!res.ok) {
      if (t + 1 < tries && res.status >= 500) { await sleep(5000); continue; }
      throw new Error(`eBay ${res.status} für ${url}`);
    }
    return html;
  }
}

/* Mehrere Suchen nacheinander. searches: [{ q, maxItems }]. Gibt Zeilen zurück; bei Sperre BlockedError mit
   err.partial = schon geholte Zeilen und err.done = Suchbegriffe, die fertig sind. */
export async function scrapeSearches(searches, { delayMs = 2500, log = () => {} } = {}) {
  const out = [], done = [];
  let first = true;
  for (const s of searches) {
    const want = Math.max(1, s.maxItems || 60);
    const ipg = want <= 60 ? 60 : want <= 120 ? 120 : 240;
    const got = [];
    try {
      for (let page = 1; got.length < want && page <= 5; page++) {
        if (!first) await sleep(delayMs + Math.random() * delayMs * 0.4);
        first = false;
        const html = await getHtml(searchUrlFor(s.q, ipg, page));
        const rows = parseSearchHtml(html, s.q);
        // eBay füllt die Seite mit "weniger Suchbegriffe" auf; die exakten Treffer zuerst
        got.push(...rows);
        const exact = rows.filter((r) => !r._rewrite).length;
        if (rows.length < ipg * 0.8 || exact < rows.length) break; // letzte Seite der exakten Treffer
      }
    } catch (e) {
      if (e instanceof BlockedError) { e.partial = out; e.done = done; }
      throw e;
    }
    out.push(...got.slice(0, want));
    done.push(s.q);
    log(`  ${s.q}: ${Math.min(got.length, want)} Zeilen`);
  }
  return out;
}
