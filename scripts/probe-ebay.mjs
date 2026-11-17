// Testabruf: Liefert ebay.de Seiten ohne Proxy an diesen Rechner aus?
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" };
const urls = [
  "https://www.ebay.de/sch/i.html?_nkw=Scherox+10%2F75&LH_Sold=1&LH_Complete=1&_sop=13",
  "https://www.ebay.de/sch/i.html?_nkw=Blastoise+Expedition+36%2F165&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=240",
  "https://www.ebay.de/itm/366664676614?nordt=true",
];
for (let round = 0; round < 3; round++) for (const u of urls) {
  const t = Date.now();
  try {
    const r = await fetch(u, { headers: H, redirect: "follow" });
    const html = await r.text();
    const items = (html.match(/class="s-(item|card)[ "]/g) || []).length;
    const ids = new Set([...html.matchAll(/\/itm\/(\d{9,15})/g)].map(m => m[1])).size;
    const block = /Pardon Our Interruption|captcha|Bitte bestätigen Sie|splashui|challenge/i.test(html);
    console.log(JSON.stringify({ round, u: u.slice(23, 90), status: r.status, final: r.url.slice(0, 80), ms: Date.now() - t, bytes: html.length, items, ids, block,
      title: (html.match(/<title>([^<]*)/) || [])[1], sold: (html.match(/Verkauft\s+\d{1,2}\.\s*\w+\.?\s*\d{4}/) || [])[0] }));
    if (round === 0) await (await import("node:fs/promises")).writeFile(`probe-${urls.indexOf(u)}.html`, html);
  } catch (e) { console.log(JSON.stringify({ round, u, err: String(e) })); }
  await new Promise(r => setTimeout(r, 1500));
}
