// EasyApt daily refresh.
// POST {"url": "<apartments.com property url>"}  -> scrape one community, append to raw_scrapes
// POST {"discover_page": 1..4}                    -> add Kyle communities from a search page to `sources`
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { DOMParser, type Element } from "jsr:@b-fuze/deno-dom@0.1.48";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};
const T = (s?: string | null) => (s || "").replace(/\s+/g, " ").trim();
const num = (s?: string | null) => +(String(s ?? "").replace(/[^0-9.]/g, "")) || 0;
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function getDoc(url: string) {
  const r = await fetch(url, { headers: HEADERS });
  const html = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) throw new Error("Could not parse page");
  return doc;
}

function extract(doc: ReturnType<DOMParser["parseFromString"]>) {
  const d = doc!;
  const tours = [...d.querySelectorAll("[data-vt-tourkey]")]
    .map((e) => e as Element)
    .filter((e) => /matterport/i.test(e.getAttribute("data-vt-type") || ""))
    .map((e) => [e.getAttribute("data-vt-tourkey"), T(e.getAttribute("data-vt-caption"))]);
  const models = [...d.querySelectorAll(".pricingGridItem")].map((n) => {
    const m = n as Element;
    const det = T(m.querySelector(".detailsTextWrapper")?.textContent);
    const beds = /studio/i.test(det) ? 0 : num((det.match(/([\d.]+)\s*Bed/i) || [])[1]);
    const baths = num((det.match(/([\d.]+)\s*Bath/i) || [])[1]);
    const sq = num((det.match(/([\d,]+)\s*Sq/i) || [])[1]);
    const units = [...m.querySelectorAll("li.unitContainer")].map((u) => {
      const t = T((u as Element).textContent);
      return [
        (t.match(/Unit\s+(\S+)/) || [])[1],
        num((t.match(/price\s+\$([\d,]+)/i) || [])[1]),
        (t.match(/availibility\s+(.+?)\s+view/i) || [])[1] || "",
      ];
    });
    return [T(m.querySelector(".modelName")?.textContent), beds, baths, sq, T(m.querySelector(".rentLabel")?.textContent), units];
  });
  const meta = (p: string) => +((d.querySelector(`meta[property="${p}"]`) as Element | null)?.getAttribute("content") || 0);
  const site = (d.querySelector('a.propertyWebsiteLink, a[title*="Website"]') as Element | null)?.getAttribute("href") || "";
  return {
    name: T(d.querySelector("#propertyName")?.textContent),
    addr: T(d.querySelector(".propertyAddressContainer")?.textContent),
    lat: meta("place:location:latitude"),
    lng: meta("place:location:longitude"),
    phone: T(d.querySelector(".phoneNumber, .propertyPhone")?.textContent),
    site: site.split("?")[0],
    tours,
    models,
  };
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  try {

    if (body.discover_page) {
      const p = Math.min(Math.max(+body.discover_page, 1), 6);
      const doc = await getDoc(`https://www.apartments.com/kyle-tx/${p === 1 ? "" : p + "/"}`);
      const rows = [...doc.querySelectorAll("article.placard")].map((n) => {
        const a = n as Element;
        const url = a.getAttribute("data-url") || (a.querySelector("a.property-link") as Element | null)?.getAttribute("href") || "";
        return { url, name: T(a.querySelector(".property-title")?.textContent), addr: T(a.querySelector(".property-address")?.textContent) };
      }).filter((r) => r.url && /Kyle/i.test(r.addr) && !/\bUnit\b|#/.test(r.addr + r.name) && !/^\d/.test(r.name) && !/furnished/i.test(r.name));
      if (rows.length) {
        await sb.from("sources").upsert(rows.map(({ url, name }) => ({ url, name })), { onConflict: "url", ignoreDuplicates: true });
      }
      return json({ page: p, found: rows.length });
    }

    const url = String(body.url || "");
    const { data: src } = await sb.from("sources").select("url").eq("url", url).eq("active", true).maybeSingle();
    if (!src) return json({ error: "Unknown source" }, 400);

    // Skip if scraped in the last 12 hours (protects against repeated calls).
    const since = new Date(Date.now() - 12 * 3600e3).toISOString();
    const { count } = await sb.from("raw_scrapes").select("id", { count: "exact", head: true }).eq("source_url", url).gte("scraped_at", since);
    if (count) return json({ skipped: url });

    const data = extract(await getDoc(url));
    if (!data.models.length) throw new Error("No floor plans found; page layout may have changed or request was blocked");
    const { error } = await sb.from("raw_scrapes").insert({ source_url: url, data });
    if (error) throw error;
    await sb.from("sources").update({ last_ok: new Date().toISOString(), last_error: null }).eq("url", url);
    return json({ ok: url, models: data.models.length, units: data.models.reduce((a, m) => a + (m[5] as unknown[]).length, 0) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (body?.url) await sb.from("sources").update({ last_error: msg.slice(0, 300) }).eq("url", body.url);
    return json({ error: msg }, 500);
  }
});
