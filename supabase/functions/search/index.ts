// EasyApt search: POST {"area": "Kyle, TX"}
// 1. Discover apartment complexes in the area with Google Places (once per area, reused for 30 days).
// 2. Detect each complex's website platform automatically (once per complex, re-checked every 30 days).
// 3. Read available units live from every complex with a supported platform (10-minute reuse window).
// Returns every complex found; ones without a readable website come back with models = null.
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

type Unit = [string, number, string, number | null];
type Model = [string, number, number, number, string, Unit[]];

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
async function discover(area: string, key: string) {
  if (!GKEY) throw new Error("Google Places key is not set (GOOGLE_PLACES_KEY)");
  const found: any[] = [];
  let pageToken = "";
  for (let page = 0; page < 3; page++) {
    const body: Record<string, unknown> = { textQuery: `apartment complexes in ${area}`, pageSize: 20 };
    if (pageToken) body.pageToken = pageToken;
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GKEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.nationalPhoneNumber,places.types,nextPageToken",
      },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Google Places: ${j?.error?.message ?? r.status}`);
    found.push(...(j.places ?? []));
    pageToken = j.nextPageToken ?? "";
    if (!pageToken) break;
  }
  // Keep places that look like apartment communities.
  const apts = found.filter((p) => {
    const t: string[] = p.types ?? [];
    const n = String(p.displayName?.text ?? "");
    return t.some((x) => /apartment|housing_complex|lodging/.test(x)) || /apartment|apts|residences|lofts|villas|flats|living|homes|place|park|commons|crossing|landing/i.test(n);
  }).filter((p) => !/storage|hotel|inn\b|suites|senior center|rv park/i.test(String(p.displayName?.text ?? "")));

  const { data: existing } = await sb.from("communities").select("place_id, area_keys").in("place_id", apts.map((p) => p.id));
  const keys = new Map((existing ?? []).map((e) => [e.place_id, e.area_keys as string[]]));
  const rows = apts.map((p) => ({
    place_id: p.id,
    name: String(p.displayName?.text ?? "Apartment community"),
    addr: p.formattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    phone: p.nationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    area_keys: [...new Set([...(keys.get(p.id) ?? []), key])],
  }));
  if (rows.length) await sb.from("communities").upsert(rows, { onConflict: "place_id" });
  const lat = rows.length ? rows.reduce((a, r) => a + (r.lat ?? 0), 0) / rows.length : null;
  const lng = rows.length ? rows.reduce((a, r) => a + (r.lng ?? 0), 0) / rows.length : null;
  await sb.from("areas").upsert({ area_key: key, query: area, lat, lng, discovered_at: new Date().toISOString(), community_count: rows.length });
}

// ---------- 2. Platform detection ----------
const PATHS = ["", "floor-plans", "floorplans/", "floorplans", "floor-plans/", "availability", "apartments/", "apartments/tx/kyle/floor-plans"];
// Patterns allow JSON-escaped slashes (e.g. sightmap.com\/embed\/abc), common when a page injects the map with JavaScript.
const RE_SIGHTMAP = /sightmap\.com\\?\/(?:app\\?\/)?embed\\?\/([a-z0-9]{8,14})/gi;
const RE_TOUR = /matterport\.com\\?\/(?:show\\?\/?\?m=|models\\?\/)([A-Za-z0-9]{11})/g;
const RE_G5 = /g5-cl-[a-z0-9]+-[a-z0-9-]+/i;
const SIGS: [string, RegExp][] = [
  ["rentcafe", /rentcafe|securecafe/i], ["entrata", /entrata|prospectportal/i], ["realpage", /realpage|g5dxm|onesite/i],
  ["appfolio", /appfolio/i], ["resman", /myresman/i], ["knock", /knockrentals|knck\.io/i], ["funnel", /funnelleasing|nestio/i],
];
async function detect(c: { place_id: string; website: string | null }) {
  const upd: Record<string, unknown> = { detected_at: new Date().toISOString() };
  if (!c.website) { upd.platform = "no_website"; upd.reader = null; return await sb.from("communities").update(upd).eq("place_id", c.place_id); }
  const base = c.website.replace(/[?#].*$/, "").replace(/\/?$/, "/");
  let blocked = false, platform = "unknown", g5urn = "";
  const embeds = new Set<string>(), tours = new Set<string>();
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
    for (const m of text.matchAll(RE_TOUR)) tours.add(m[1]);
    if (!g5urn) g5urn = text.match(RE_G5)?.[0] ?? "";
    if (embeds.size) break;
  }
  if (!embeds.size && !blocked) {
    for (const p of extra) {
      const { text } = await getText(base + p, 7000);
      for (const m of text.matchAll(RE_SIGHTMAP)) embeds.add(m[1]);
      for (const m of text.matchAll(RE_TOUR)) tours.add(m[1]);
      if (!g5urn) g5urn = text.match(RE_G5)?.[0] ?? "";
      if (embeds.size) break;
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
  if (tours.size) upd.tours = [...tours].slice(0, 12).map((id) => [id, ""]);
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
  for (const fp of d.floor_plans ?? []) plans.set(String(fp.id), [planName(fp), +fp.bedroom_count || 0, +fp.bathroom_count || 0, 0, "", []]);
  for (const u of d.units ?? []) {
    const m = plans.get(String(u.floor_plan_id));
    if (!m) continue;
    const area = +u.area || 0;
    if (area && (!m[3] || area < m[3])) m[3] = area;
    const avail = u.available_on && !/now/i.test(String(u.display_available_on ?? "")) ? String(u.available_on) : "Now";
    m[5].push([String(u.unit_number ?? u.label), Math.round(+u.price || 0), avail, floorNum.get(String(u.floor_id)) ?? null]);
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
      return [String(x.displayName || x.name), Math.round(+(rate?.value ?? 0)), av, null];
    });
    return [String(f.name), +f.beds || 0, +f.baths || 0, +f.sqft || 0, "", units];
  });
  return models.filter((m) => m[5].length);
}

const READERS: Record<string, (cfg: any) => Promise<Model[]>> = { sightmap: readSightmap, g5: readG5 };

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { area: rawArea } = await req.json().catch(() => ({}));
    const area = String(rawArea ?? "").trim().slice(0, 80);
    if (area.length < 2) return json({ error: "Enter a city, neighborhood, or ZIP code." }, 400);
    const key = areaKey(area);

    const { data: a } = await sb.from("areas").select("*").eq("area_key", key).maybeSingle();
    let discoveredNow = false;
    if (!a || Date.now() - new Date(a.discovered_at).getTime() > 30 * DAY) { await discover(area, key); discoveredNow = true; }

    let { data: comms } = await sb.from("communities").select("*").contains("area_keys", [key]);
    comms = comms ?? [];
    const stale = comms.filter((c) => !c.detected_at || Date.now() - new Date(c.detected_at).getTime() > 30 * DAY);
    if (stale.length) {
      await withTimeout(pool(stale, 10, detect), 90000).catch(() => {});
      comms = (await sb.from("communities").select("*").contains("area_keys", [key])).data ?? [];
    }

    const { data: snaps } = await sb.from("listings").select("source_url, data, scraped_at").like("source_url", "https://www.apartments.com/%");
    const snapBy = new Map((snaps ?? []).map((s) => [domain(s.data?.site), s]));

    const results = await pool(comms, 10, async (c) => {
      const base = { place_id: c.place_id, name: c.name, addr: c.addr, lat: c.lat, lng: c.lng, phone: c.phone, site: c.website, platform: c.platform, tours: c.tours ?? [] };
      if (c.reader && READERS[c.reader]) {
        const r = await readLive(c);
        if (r.models) return { ...base, ...r };
      }
      const snap = snapBy.get(domain(c.website));
      if (snap) return { ...base, status: "saved", fetched_at: snap.scraped_at, models: snap.data.models, tours: (snap.data.tours?.length ? snap.data.tours : base.tours) };
      return { ...base, status: "none", fetched_at: null, models: null };
    });

    const { data: aa } = await sb.from("areas").select("lat,lng,query").eq("area_key", key).maybeSingle();
    return json({ area: aa ?? { query: area }, discoveredNow, communities: results });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
