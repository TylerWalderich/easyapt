// EasyApt search: POST {"area": "Kyle, TX"}
// 1. Discover apartment complexes in the area with Google Places (once per area, reused for 30 days).
// 2. Detect each complex's website platform automatically (once per complex, re-checked every 30 days).
// 3. Read available units live from every complex with a supported platform (10-minute reuse window).
// Returns every complex found; ones without a readable website come back with models = null.
// Rentals of three kinds: apartments, townhomes, and houses. Houses and townhomes come from rental-home
// communities found on Google and from local property managers' public listing pages (AppFolio, Buildium).
// Each floor plan gets a feature key; the "smart" function reads plan images with AI to tag features.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GKEY = Deno.env.get("GOOGLE_PLACES_KEY") ?? "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const DAY = 86400e3;

// Unit: [number, rent, available (ISO or "Now"), floor, Matterport id]
// Model: [plan name, beds, baths, sqft, Matterport id for the plan, units, floor plan image URL]
type Unit = [string, number, string, number | null, string | null];
type Model = [string, number, number, number, string, Unit[], string, string?];
type Listing = { id: string; title: string; addr: string; beds: number; baths: number; sqft: number; rent: number; avail: string; img: string; url: string; kind: string; desc: string };
const SMART_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/smart`;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const DISCOVERY_V = 2;

// ---------- helpers ----------
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}
async function getText(url: string, ms = 8000): Promise<{ status: number; text: string; url: string }> {
  try {
    const r = await withTimeout(fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/json", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" }), ms);
    return { status: r.status, text: r.ok ? await r.text() : "", url: r.url };
  } catch {
    return { status: 0, text: "", url };
  }
}
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
const areaKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------- 1. Discovery (Google Places Text Search) ----------
const FIELDS = "places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.nationalPhoneNumber,places.types,nextPageToken";
async function places(q: string, pages: number) {
  const out: any[] = [];
  let pageToken = "";
  for (let page = 0; page < pages; page++) {
    const body: Record<string, unknown> = { textQuery: q, pageSize: 20 };
    if (pageToken) body.pageToken = pageToken;
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GKEY, "X-Goog-FieldMask": FIELDS }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Google Places: ${j?.error?.message ?? r.status}`);
    out.push(...(j.places ?? []));
    pageToken = j.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
}
const NOT_RENTAL = /storage|hotel|\binn\b|suites|senior center|rv park|mobile home|manufactured|d\.?\s?r\.? horton|lennar|pulte|kb home|meritage|taylor morrison|perry homes|new homes|model home|builder|realty one|keller williams|re\/?max|coldwell|century 21|exp realty/i;
function kindOf(name: string, site: string | null, types: string[]): string {
  const t = `${name} ${site ?? ""}`;
  if (/townhome|townhouse|town home|town house/i.test(t)) return "townhome";
  if (/rental homes|homes for rent|rental-homes|for-rent-homes|cottages|casitas|bungalows|single[- ]family|build[- ]to[- ]rent|\bbtr\b|coveyhomes|homes by/i.test(t)) return "house";
  return "apartment";
}
async function discover(area: string, key: string) {
  if (!GKEY) throw new Error("Google Places key is not set (GOOGLE_PLACES_KEY)");
  const [apts, towns, homes, mgrs] = await Promise.all([
    places(`apartment complexes in ${area}`, 3),
    places(`townhomes for rent in ${area}`, 1).catch(() => []),
    places(`rental homes community in ${area}`, 1).catch(() => []),
    places(`property management company in ${area}`, 1).catch(() => []),
  ]);
  const seen = new Map<string, { p: any; kind: string }>();
  for (const p of [...apts, ...towns, ...homes]) {
    const n = String(p.displayName?.text ?? ""), t: string[] = p.types ?? [];
    if (NOT_RENTAL.test(n) || t.some((x) => /mobile_home_park|rv_park|hotel|general_contractor|home_builder/.test(x))) continue;
    const looksRental = t.some((x) => /apartment|housing_complex|condominium/.test(x)) ||
      /apartment|apts|residences|lofts|villas|flats|living|homes|townhome|townhouse|place|park|commons|crossing|landing|reserve|estates/i.test(n);
    if (!looksRental || seen.has(p.id)) continue;
    seen.set(p.id, { p, kind: kindOf(n, p.websiteUri ?? null, t) });
  }
  for (const p of mgrs) {
    const n = String(p.displayName?.text ?? ""), t: string[] = p.types ?? [];
    if (seen.has(p.id) || !p.websiteUri || t.some((x) => /apartment_complex/.test(x))) continue;
    if (!/manage|property|properties|realty|rentals|leasing|homes/i.test(n)) continue;
    seen.set(p.id, { p, kind: "manager" });
  }
  const list = [...seen.values()];
  const { data: existing } = await sb.from("communities").select("place_id, area_keys").in("place_id", list.map((x) => x.p.id));
  const keys = new Map((existing ?? []).map((e) => [e.place_id, e.area_keys as string[]]));
  const rows = list.map(({ p, kind }) => ({
    place_id: p.id,
    name: String(p.displayName?.text ?? "Rental community"),
    addr: p.formattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    phone: p.nationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    kind,
    area_keys: [...new Set([...(keys.get(p.id) ?? []), key])],
  }));
  if (rows.length) await sb.from("communities").upsert(rows, { onConflict: "place_id" });
  const local = rows.filter((r) => r.kind !== "manager" && r.lat != null);
  const lat = local.length ? local.reduce((a, r) => a + r.lat!, 0) / local.length : null;
  const lng = local.length ? local.reduce((a, r) => a + r.lng!, 0) / local.length : null;
  await sb.from("areas").upsert({ area_key: key, query: area, lat, lng, discovered_at: new Date().toISOString(), community_count: rows.length, discovery_v: DISCOVERY_V });
}

// ---------- 2. Platform detection ----------
const PATHS = ["", "floor-plans", "floorplans/", "floorplans", "floor-plans/", "availability", "apartments/", "apartments/tx/kyle/floor-plans"];
// Patterns allow JSON-escaped slashes (e.g. sightmap.com\/embed\/abc), common when a page injects the map with JavaScript.
const RE_SIGHTMAP = /sightmap\.com\\?\/(?:app\\?\/)?embed\\?\/([a-z0-9]{8,14})/gi;
// Virtual tour providers we recognise and can embed. Patterns tolerate JSON-escaped slashes.
const TOUR_HOSTS = [
  "my\\.matterport\\.com", "matterport\\.com", "youtube\\.com", "youtu\\.be", "youtube-nocookie\\.com", "player\\.vimeo\\.com", "vimeo\\.com",
  "api\\.realync\\.com", "realync\\.com", "kuula\\.co", "youriguide\\.com", "iguide\\.[a-z]+", "zillow\\.com\\\\?/view-3d-home",
  "fast\\.wistia\\.(?:net|com)", "[a-z0-9-]+\\.wistia\\.com", "app\\.cloudpano\\.com", "[a-z0-9-]+\\.panoskin\\.com", "peek\\.us",
  "tours\\.ricoh360\\.com", "theasys\\.io", "my\\.3dvista\\.com", "[a-z0-9-]+\\.3dvista\\.com", "tourbuilder\\.[a-z]+", "eyespy360\\.com",
  "tour\\.giraffe360\\.com", "[a-z0-9-]+\\.giraffe360\\.com", "momento360\\.com", "roundme\\.com", "panoee\\.com", "virtualtourcafe\\.com",
  "cupix\\.works", "[a-z0-9-]+\\.cupix\\.works", "teliportme\\.com", "tourwizard\\.net", "spinattic\\.com", "bnbvr\\.com",
];
const RE_TOURURL = new RegExp(`https?:\\\\?/\\\\?/(?:www\\.)?(?:${TOUR_HOSTS.join("|")})[^"'\\s<>\\\\]*(?:\\\\/[^"'\\s<>\\\\]*)*`, "gi");
function cleanTourUrl(raw: string): string | null {
  let u = raw.replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/[),.;]+$/, "");
  try {
    const x = new URL(u);
    const h = x.hostname.replace(/^www\./, "");
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(h)) {
      const id = x.searchParams.get("v") || x.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1];
      return id ? `https://www.youtube.com/watch?v=${id}` : null;
    }
    if (h === "youtu.be") { const id = x.pathname.slice(1, 12); return id ? `https://www.youtube.com/watch?v=${id}` : null; }
    if (h.endsWith("vimeo.com")) { const id = x.pathname.match(/(\d{6,})/)?.[1]; return id ? `https://vimeo.com/${id}` : null; }
    if (h.endsWith("matterport.com")) { const id = x.searchParams.get("m") || x.pathname.match(/models\/([A-Za-z0-9]{11})/)?.[1]; return id ? `https://my.matterport.com/show/?m=${id}` : null; }
    if (x.pathname.length < 3 && !x.search) return null; // a bare homepage link, not a tour
    return x.toString();
  } catch { return null; }
}
const RE_TOUR = /matterport\.com\\?\/(?:show\\?\/?\?m=|models\\?\/)([A-Za-z0-9]{11})/g;
const RE_G5 = /g5-cl-[a-z0-9]+-[a-z0-9-]+/i;
const SIGS: [string, RegExp][] = [
  ["rentcafe", /rentcafe|securecafe/i], ["entrata", /entrata|prospectportal/i], ["realpage", /realpage|g5dxm|onesite/i],
  ["appfolio", /appfolio/i], ["resman", /myresman/i], ["knock", /knockrentals|knck\.io/i], ["funnel", /funnelleasing|nestio/i],
];
// Collect tours from one page: structured data (schema.org FloorPlan objects carry the plan name)
// first, then any other tour links on the page as community-wide tours.
function collectTours(html: string, into: Map<string, string>) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const walk = (node: any, plan: string) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach((n) => walk(n, plan)); return; }
      const t = String(node["@type"] ?? "");
      const isPlan = /FloorPlan/i.test(t) || (node.name && (node.numberOfBedrooms !== undefined || node.floorSize));
      const label = isPlan && node.name ? String(node.name).trim() : plan;
      for (const v of Object.values(node)) {
        if (typeof v === "string") {
          for (const u of v.matchAll(RE_TOURURL)) { const clean = cleanTourUrl(u[0]); if (clean && (!into.has(clean) || !into.get(clean))) into.set(clean, label); }
        } else walk(v, label);
      }
    };
    walk(data, "");
  }
  for (const u of html.matchAll(RE_TOURURL)) { const clean = cleanTourUrl(u[0]); if (clean && !into.has(clean)) into.set(clean, ""); }
}

const RE_APPFOLIO = /\b([a-z0-9][a-z0-9-]{1,40})\.appfolio\.com/gi;
const RE_BUILDIUM = /\b([a-z0-9][a-z0-9-]{1,40})\.managebuilding\.com/gi;
const AF_SKIP = /^(www|images|listings|cdn|static|assets|help|api|app)$/i;
async function detectManager(c: { place_id: string; website: string }) {
  const upd: Record<string, unknown> = { detected_at: new Date().toISOString(), reader: null, reader_config: null };
  const base = c.website.replace(/[?#].*$/, "").replace(/\/?$/, "/");
  let af = "", bd = "", blocked = false;
  for (const p of ["", "rentals", "available-rentals", "rental-listings", "homes-for-rent", "listings", "vacancies", "properties"]) {
    const { status, text } = await getText(base + p, 7000);
    if (p === "" && (status === 403 || status === 429)) { blocked = true; break; }
    for (const m of text.matchAll(RE_APPFOLIO)) if (!af && !AF_SKIP.test(m[1])) af = m[1].toLowerCase();
    for (const m of text.matchAll(RE_BUILDIUM)) if (!bd) bd = m[1].toLowerCase();
    if (af || bd) break;
  }
  if (af) { upd.reader = "appfolio"; upd.reader_config = { sub: af }; upd.platform = "appfolio"; }
  else if (bd) { upd.reader = "buildium"; upd.reader_config = { sub: bd }; upd.platform = "buildium"; }
  else upd.platform = blocked ? "blocked" : "unknown";
  return await sb.from("communities").update(upd).eq("place_id", c.place_id);
}

async function detect(c: { place_id: string; website: string | null; kind?: string }) {
  const upd: Record<string, unknown> = { detected_at: new Date().toISOString() };
  if (!c.website) { upd.platform = "no_website"; upd.reader = null; return await sb.from("communities").update(upd).eq("place_id", c.place_id); }
  if (c.kind === "manager") return await detectManager(c as { place_id: string; website: string });
  const base = c.website.replace(/[?#].*$/, "").replace(/\/?$/, "/");
  let blocked = false, platform = "unknown", g5urn = "";
  const embeds = new Set<string>(), tours = new Map<string, string>();
  // Same-site floor plan links found on the home page are checked too.
  const extra: string[] = [];
  for (const p of PATHS) {
    const { status, text } = await getText(base + p, 7000);
    if (p === "" && (status === 403 || status === 429)) { blocked = true; break; }
    if (!text) continue;
    if (p === "") {
      for (const m of text.matchAll(/href="(\/[^"#?]*(?:floor-?plans?|availability)[^"#?]*)"/gi)) if (extra.length < 3) extra.push(m[1].replace(/^\//, ""));
      for (const [name, re] of SIGS) if (platform === "unknown" && re.test(text)) platform = name;
    }
    for (const m of text.matchAll(RE_SIGHTMAP)) embeds.add(m[1]);
    collectTours(text, tours);
    if (!g5urn) g5urn = text.match(RE_G5)?.[0] ?? "";
    if (embeds.size && tours.size) break;
  }
  if ((!embeds.size || !tours.size) && !blocked) {
    for (const p of extra) {
      const { text } = await getText(base + p, 7000);
      for (const m of text.matchAll(RE_SIGHTMAP)) embeds.add(m[1]);
      collectTours(text, tours);
      if (!g5urn) g5urn = text.match(RE_G5)?.[0] ?? "";
      if (embeds.size && tours.size) break;
    }
  }
  upd.reader = null; upd.reader_config = null;
  for (const e of embeds) {
    const { text } = await getText(`https://sightmap.com/embed/${e}`, 7000);
    const api = text.match(/app\/api\/v1\/[a-z0-9]+\/sightmaps\/\d+/i)?.[0];
    if (api) { upd.reader = "sightmap"; upd.reader_config = { api }; platform = "sightmap"; break; }
  }
  if (!upd.reader && g5urn) { upd.reader = "g5"; upd.reader_config = { urn: g5urn }; platform = "g5"; }
  upd.platform = blocked ? "blocked" : platform;
  // Tours are stored as [url, floor plan name or ""]; plan-specific tours first.
  upd.tours = [...tours].sort((a, b) => (b[1] ? 1 : 0) - (a[1] ? 1 : 0)).slice(0, 40);
  return await sb.from("communities").update(upd).eq("place_id", c.place_id);
}

// ---------- 3. Readers ----------
// Some SightMap maps store the plan name as packed JSON text, e.g. {"name":"A1","provider_id":"1"}.
function planName(fp: any): string {
  let n: any = fp.name;
  if (typeof n === "string" && n.trim().startsWith("{")) { try { n = JSON.parse(n).name; } catch { /* keep text */ } }
  if (n && typeof n === "object") n = n.name;
  return String(n || fp.filter_label || "Plan").trim();
}
async function readSightmap(cfg: { api: string }): Promise<Model[]> {
  const r = await withTimeout(fetch(`https://sightmap.com/${cfg.api}`, { headers: { "User-Agent": UA, Accept: "application/json" } }), 10000);
  if (!r.ok) throw new Error(`SightMap HTTP ${r.status}`);
  const j = await r.json();
  const d = j.data ?? j;
  const floorNum = new Map<string, number | null>();
  for (const f of d.floors ?? []) {
    const n = parseInt(String(f.filter_short_label ?? f.filter_label ?? "").replace(/\D/g, ""), 10);
    floorNum.set(String(f.id), Number.isFinite(n) ? n : null);
  }
  const plans = new Map<string, Model>();
  for (const fp of d.floor_plans ?? []) plans.set(String(fp.id), [planName(fp), +fp.bedroom_count || 0, +fp.bathroom_count || 0, 0, "", [], String(fp.image_url ?? "")]);
  for (const u of d.units ?? []) {
    const m = plans.get(String(u.floor_plan_id));
    if (!m) continue;
    const area = +u.area || 0;
    if (area && (!m[3] || area < m[3])) m[3] = area;
    const avail = u.available_on && !/now/i.test(String(u.display_available_on ?? "")) ? String(u.available_on) : "Now";
    const tour = (u.outbound_links ?? []).map((l: any) => String(l?.url ?? "").match(/matterport\.com\/(?:show\/?\?m=|models\/)([A-Za-z0-9]{11})/)?.[1]).find(Boolean) ?? null;
    if (tour && !m[4]) m[4] = tour;
    m[5].push([String(u.unit_number ?? u.label), Math.round(+u.price || 0), avail, floorNum.get(String(u.floor_id)) ?? null, tour]);
  }
  return [...plans.values()].filter((m) => m[5].length);
}
// ---------- Reader: G5 (inventory.g5marketingcloud.com; sites built by G5 / RealPage marketing) ----------
async function g5(query: string, variables: Record<string, unknown>) {
  const r = await withTimeout(fetch("https://inventory.g5marketingcloud.com/graphql", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ query, variables }),
  }), 10000);
  const j = await r.json();
  if (!r.ok || j.errors?.length) throw new Error(`G5: ${j.errors?.[0]?.message ?? r.status}`);
  return j.data;
}
async function readG5(cfg: { urn: string }): Promise<Model[]> {
  const d = await g5(`query($l:String!){ apartmentComplex(locationUrn:$l){ floorplans{ id name beds baths sqft totalAvailableUnits } } }`, { l: cfg.urn });
  const fps = (d?.apartmentComplex?.floorplans ?? []).filter((f: any) => (f.totalAvailableUnits ?? 1) > 0);
  const today = new Date().toISOString().slice(0, 10);
  const models = await pool(fps, 5, async (f: any): Promise<Model> => {
    const u = await g5(`query($l:String,$f:ID){ units(locationUrn:$l,floorplanId:$f){ name displayName availabilityDate prices{ value priceType } } }`, { l: cfg.urn, f: String(f.id) });
    const units: Unit[] = (u?.units ?? []).map((x: any) => {
      const rate = (x.prices ?? []).find((p: any) => p.priceType === "rate") ?? (x.prices ?? [])[0];
      const av = x.availabilityDate && x.availabilityDate > today ? x.availabilityDate : "Now";
      return [String(x.displayName || x.name), Math.round(+(rate?.value ?? 0)), av, null, null];
    });
    return [String(f.name), +f.beds || 0, +f.baths || 0, +f.sqft || 0, "", units, ""];
  });
  return models.filter((m) => m[5].length);
}

const READERS: Record<string, (cfg: any) => Promise<Model[]>> = { sightmap: readSightmap, g5: readG5 };

// ---------- Readers for property managers' public listing pages ----------
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|’/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function availDate(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!t || /now|immediate|today/.test(t)) return "Now";
  let d: Date | null = null;
  const mdY = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (mdY) d = new Date(+(mdY[3].length === 2 ? "20" + mdY[3] : mdY[3]), +mdY[1] - 1, +mdY[2]);
  const mon = t.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/);
  if (!d && mon) {
    const now = new Date();
    d = new Date(mon[3] ? +mon[3] : now.getFullYear(), MONTHS.indexOf(mon[1]), +mon[2]);
    if (!mon[3] && d.getTime() < now.getTime() - 60 * DAY) d.setFullYear(d.getFullYear() + 1);
  }
  if (!d || isNaN(d.getTime()) || d.getTime() <= Date.now()) return "Now";
  return d.toISOString().slice(0, 10);
}
function kindFromText(addr: string, text: string, fallback: string) {
  if (/townhome|townhouse|town home|duplex|condo/i.test(text)) return "townhome";
  if (/\b(unit|apt|apartment|suite|ste)\b|#\s*\w/i.test(addr)) return "apartment";
  if (/apartment|studio/i.test(text) && !/house|home/i.test(text)) return "apartment";
  return fallback;
}
async function readAppfolio(cfg: { sub: string }): Promise<Listing[]> {
  const base = `https://${cfg.sub}.appfolio.com`;
  const { status, text } = await getText(`${base}/listings`, 12000);
  if (!text) throw new Error(`AppFolio HTTP ${status}`);
  return text.split(/<div class="listing-item result js-listing-item"/).slice(1).map((h): Listing | null => {
    const id = h.match(/\/listings\/detail\/([0-9a-f-]{20,})/)?.[1];
    if (!id) return null;
    const dd = (label: string) => strip(h.match(new RegExp(`${label}</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, "i"))?.[1] ?? "");
    const bb = dd("Bed / Bath");
    const beds = /studio/i.test(bb) ? 0 : parseFloat(bb.match(/([\d.]+)\s*bd/i)?.[1] ?? "0");
    const baths = parseFloat(bb.match(/([\d.]+)\s*ba/i)?.[1] ?? "0");
    let addr = strip(h.match(/js-listing-address">([\s\S]*?)<\/span>/)?.[1] ?? "");
    const dup = addr.match(/^(.*?)\s+([A-Za-z .'-]+),\s*([A-Z]{2}\s*\d{5}),\s*\2,\s*\3$/); // "Street Austin, TX 78741, Austin, TX 78741"
    if (dup) addr = `${dup[1]}, ${dup[2].trim()}, ${dup[3]}`;
    const title = strip(h.match(/js-listing-title">\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? addr);
    const desc = strip(h.match(/js-listing-description">([\s\S]*?)<\/p>/)?.[1] ?? "") + " " + strip(h.match(/Appliances:<\/span>([\s\S]*?)<br/)?.[1] ?? "");
    return {
      id, title, addr, beds, baths, sqft: +dd("Square Feet").replace(/\D/g, "") || 0, rent: +dd("RENT").replace(/[^\d.]/g, "") || 0,
      avail: availDate(dd("Available")), img: h.match(/data-original="([^"]+)"/)?.[1] ?? "", url: `${base}/listings/detail/${id}`,
      kind: kindFromText(addr, `${title} ${desc}`, "house"), desc: desc.trim().slice(0, 600),
    };
  }).filter((x): x is Listing => !!x && x.rent > 0);
}
async function readBuildium(cfg: { sub: string }): Promise<Listing[]> {
  const base = `https://${cfg.sub}.managebuilding.com`;
  const { status, text } = await getText(`${base}/Resident/public/rentals`, 12000);
  if (!text) throw new Error(`Buildium HTTP ${status}`);
  const TYPE: Record<string, string> = { SingleFamily: "house", CondoTownhome: "townhome", MultiFamily: "apartment" };
  return text.split(/<a class="featured-listing/).slice(1).map((h): Listing | null => {
    const attr = (n: string) => h.match(new RegExp(`data-${n}="([^"]*)"`))?.[1] ?? "";
    const id = h.match(/href="\/Resident\/public\/rentals\/(\d+)"/)?.[1];
    const kind = TYPE[attr("type")];
    if (!id || !kind) return null;
    const street = strip(h.match(/featured-listing__title">([\s\S]*?)<\/h3>/)?.[1] ?? "");
    const city = strip(h.match(/featured-listing__address">([\s\S]*?)<\/p>/)?.[1] ?? "");
    const desc = strip(h.match(/featured-listing__description[^>]*>([\s\S]*?)<div/)?.[1] ?? "");
    const img = h.match(/<img src="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ?? "";
    const addr = city ? `${street}, ${city}` : street;
    return {
      id, title: street, addr, beds: +attr("bedrooms") || 0, baths: +attr("bathrooms") || 0, sqft: +attr("square-feet") || 0, rent: Math.round(+attr("rent") || 0),
      avail: availDate(strip(h.match(/featured-listing__availability[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/^available\s*/i, "")),
      img: img ? (img.startsWith("http") ? img : base + img) : "", url: `${base}/Resident/public/rentals/${id}`,
      kind: kind === "house" ? kindFromText(addr, `${street} ${desc}`, "house") : kind, desc: desc.slice(0, 600),
    };
  }).filter((x): x is Listing => !!x && x.rent > 0);
}
// Managers also post parking spots, storage units and offices; those aren't homes.
const NOT_HOME = /\b(parking|garage space|carport space|storage|office|retail|commercial|warehouse|land|lot only|boat slip|rv space)\b/i;
const isHome = (l: Listing) => l.rent >= 300 && !NOT_HOME.test(l.title);
const LISTING_READERS: Record<string, (cfg: any) => Promise<Listing[]>> = {
  appfolio: async (cfg) => (await readAppfolio(cfg)).filter(isHome),
  buildium: async (cfg) => (await readBuildium(cfg)).filter(isHome),
};

// Free US Census geocoder for listing addresses; results cached forever.
async function geocode(addrs: string[]): Promise<Map<string, [number, number] | null>> {
  const out = new Map<string, [number, number] | null>();
  const uniq = [...new Set(addrs.filter(Boolean))];
  const { data } = await sb.from("geocodes").select("addr,lat,lng,ok").in("addr", uniq);
  for (const g of data ?? []) out.set(g.addr, g.ok ? [g.lat, g.lng] : null);
  const todo = uniq.filter((a) => !out.has(a)).slice(0, 500);
  await pool(todo, 16, async (a) => {
    const { text } = await getText(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(a.replace(/\s*(#|unit|apt\.?)\s*[\w-]+/i, ""))}&benchmark=Public_AR_Current&format=json`, 8000);
    let hit: [number, number] | null = null;
    try { const c = JSON.parse(text)?.result?.addressMatches?.[0]?.coordinates; if (c) hit = [c.y, c.x]; } catch { /* no match */ }
    if (text) await sb.from("geocodes").upsert({ addr: a, lat: hit?.[0] ?? null, lng: hit?.[1] ?? null, ok: !!hit });
    out.set(a, hit);
  });
  return out;
}
const km = (a: [number, number], b: [number, number]) => {
  const r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos(((a[0] + b[0]) / 2) * r), y = (b[0] - a[0]) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};
async function readManager(c: any, center: [number, number] | null) {
  const src = `place:${c.place_id}`;
  let listings: Listing[] | null = null, fetched = new Date().toISOString();
  if (c.last_ok && Date.now() - new Date(c.last_ok).getTime() < 10 * 60e3) {
    const { data } = await sb.from("listings").select("data, scraped_at").eq("source_url", src).maybeSingle();
    if (data?.data?.listings) { listings = data.data.listings; fetched = data.scraped_at; }
  }
  if (!listings) {
    try {
      listings = await LISTING_READERS[c.reader](c.reader_config);
      await sb.from("raw_scrapes").insert({ source_url: src, scraped_at: fetched, data: { name: c.name, listings, reader: c.reader } });
      await sb.from("communities").update({ last_ok: fetched, last_error: null }).eq("place_id", c.place_id);
    } catch (e) {
      await sb.from("communities").update({ last_error: String(e).slice(0, 300) }).eq("place_id", c.place_id);
      return [];
    }
  }
  const geo = await geocode(listings.map((l) => l.addr));
  return listings.flatMap((l) => {
    const g = geo.get(l.addr);
    if (!g || (center && km(center, g) > 40)) return [];
    const unit: Unit = [l.kind === "house" ? "Whole home" : l.title.match(/#\s*([\w-]+)/)?.[1] ?? "Home", l.rent, l.avail, null, null];
    const model: Model = [l.kind === "house" ? "House" : l.kind === "townhome" ? "Townhome" : "Apartment", l.beds, l.baths, l.sqft, "", [unit], l.img];
    return [{
      place_id: `${c.place_id}~${l.id}`, name: l.addr.split(",")[0] || l.title, addr: l.addr, lat: g[0], lng: g[1], phone: c.phone,
      site: l.url, platform: c.reader, tours: [], kind: l.kind, listing: true, manager: c.name, desc: l.desc,
      status: "live", fetched_at: fetched, models: [model],
    }];
  });
}

async function readLive(c: any) {
  const src = `place:${c.place_id}`;
  if (c.last_ok && Date.now() - new Date(c.last_ok).getTime() < 10 * 60e3) {
    const { data } = await sb.from("listings").select("data, scraped_at").eq("source_url", src).maybeSingle();
    if (data) return { status: "live", fetched_at: data.scraped_at, models: data.data.models };
  }
  try {
    const models = await READERS[c.reader](c.reader_config);
    const now = new Date().toISOString();
    await sb.from("raw_scrapes").insert({ source_url: src, scraped_at: now, data: { name: c.name, models, reader: c.reader } });
    await sb.from("communities").update({ last_ok: now, last_error: null }).eq("place_id", c.place_id);
    return { status: "live", fetched_at: now, models };
  } catch (e) {
    await sb.from("communities").update({ last_error: String(e).slice(0, 300) }).eq("place_id", c.place_id);
    return { status: "error", fetched_at: null, models: null };
  }
}

// Saved snapshots from the first Kyle collection, matched by website address (host + path).
const domain = (u?: string | null) => { try { const x = new URL(String(u)); return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return ""; } };

// Each floor plan gets a stable feature key (from its image, or its community + name) so AI tags are reused.
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 10).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function attachFeatureKeys(results: any[]) {
  const rows: any[] = [];
  for (const r of results) {
    if (!r.models) continue;
    for (const m of r.models as Model[]) {
      const img = typeof m[6] === "string" ? m[6] : "";
      const key = await sha(img ? img.replace(/[?#].*$/, "") : `${r.place_id}|${m[0]}`);
      m[7] = key;
      rows.push({
        key, place_id: r.place_id, plan: String(m[0]).slice(0, 120), image_url: img || null,
        input_text: [`${r.kind ?? "apartment"} "${r.name}"`, `plan ${m[0]}`, `${m[1]} bd ${m[2]} ba${m[3] ? " " + m[3] + " sq ft" : ""}`, r.desc ?? ""].join(" · ").slice(0, 900),
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) await sb.from("plan_features").upsert(rows.slice(i, i + 500), { onConflict: "key", ignoreDuplicates: true });
  return rows.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { area: rawArea } = await req.json().catch(() => ({}));
    const area = String(rawArea ?? "").trim().slice(0, 80);
    if (area.length < 2) return json({ error: "Enter a city, neighborhood, or ZIP code." }, 400);
    const key = areaKey(area);

    const { data: a } = await sb.from("areas").select("*").eq("area_key", key).maybeSingle();
    let discoveredNow = false;
    if (!a || (a.discovery_v ?? 1) < DISCOVERY_V || Date.now() - new Date(a.discovered_at).getTime() > 30 * DAY) { await discover(area, key); discoveredNow = true; }

    let { data: comms } = await sb.from("communities").select("*").contains("area_keys", [key]);
    comms = comms ?? [];
    const stale = comms.filter((c) => !c.detected_at || Date.now() - new Date(c.detected_at).getTime() > 30 * DAY);
    if (stale.length) {
      await withTimeout(pool(stale, 10, detect), 90000).catch(() => {});
      comms = (await sb.from("communities").select("*").contains("area_keys", [key])).data ?? [];
    }
    const { data: aa } = await sb.from("areas").select("lat,lng,query").eq("area_key", key).maybeSingle();
    const center: [number, number] | null = aa?.lat != null ? [aa.lat, aa.lng] : null;

    const { data: snaps } = await sb.from("listings").select("source_url, data, scraped_at").like("source_url", "https://www.apartments.com/%");
    const snapBy = new Map((snaps ?? []).map((s) => [domain(s.data?.site), s]));

    const managers = comms.filter((c) => c.kind === "manager");
    const sites = comms.filter((c) => c.kind !== "manager");
    const [results, homes] = await Promise.all([
      pool(sites, 10, async (c) => {
        const base = { place_id: c.place_id, name: c.name, addr: c.addr, lat: c.lat, lng: c.lng, phone: c.phone, site: c.website, platform: c.platform, tours: c.tours ?? [], kind: c.kind ?? "apartment" };
        if (c.reader && READERS[c.reader]) {
          const r = await readLive(c);
          if (r.models) return { ...base, ...r };
        }
        const snap = snapBy.get(domain(c.website));
        if (snap) return { ...base, status: "saved", fetched_at: snap.scraped_at, models: snap.data.models, tours: (snap.data.tours?.length ? snap.data.tours : base.tours) };
        return { ...base, status: "none", fetched_at: null, models: null };
      }),
      pool(managers.filter((c) => c.reader && LISTING_READERS[c.reader]), 5, (c) => readManager(c, center).catch(() => [])),
    ]);
    // A home listed by two managers shows once.
    const seenAddr = new Set<string>();
    const homeList = homes.flat().filter((h: any) => { const k = h.addr.toLowerCase().replace(/[^a-z0-9]/g, ""); if (seenAddr.has(k)) return false; seenAddr.add(k); return true; });
    const all = [...results, ...homeList];

    const nPlans = await attachFeatureKeys(all).catch(() => 0);
    // Read new floor plans with AI in the background (the smart function only takes plans not yet tagged).
    if (nPlans && ANON) {
      // @ts-ignore EdgeRuntime is provided by Supabase
      EdgeRuntime.waitUntil(fetch(SMART_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON }, body: JSON.stringify({ action: "tag" }) }).catch(() => {}));
    }
    return json({ area: aa ?? { query: area }, discoveredNow, managers: managers.map((m) => ({ name: m.name, site: m.website, platform: m.platform })), communities: all });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
