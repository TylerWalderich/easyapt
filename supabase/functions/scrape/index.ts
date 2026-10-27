// EasyApt daily refresh: reads availability from each property's own website platform.
// POST {"url": "<source url>"}  -> refresh one community (must exist in `sources` with a reader)
// Output row shape (raw_scrapes.data) matches what the website expects:
//   { name, addr, lat, lng, phone, site, tours, models: [[plan, beds, baths, sqft, label, [[unit, price, availISO, floor]]]] }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

type Unit = [string, number, string, number | null];
type Model = [string, number, number, number, string, Unit[]];

// ---------- Reader: SightMap (sightmap.com building maps; includes the real floor of every unit) ----------
async function readSightmap(cfg: { api: string }): Promise<Model[]> {
  const r = await fetch(`https://sightmap.com/${cfg.api}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`SightMap HTTP ${r.status}`);
  const j = await r.json();
  const d = j.data ?? j;
  const floorNum = new Map<string, number | null>();
  for (const f of d.floors ?? []) {
    const n = parseInt(String(f.filter_short_label ?? f.filter_label ?? "").replace(/\D/g, ""), 10);
    floorNum.set(String(f.id), Number.isFinite(n) ? n : null);
  }
  const plans = new Map<string, Model>();
  for (const fp of d.floor_plans ?? []) {
    plans.set(String(fp.id), [String(fp.name ?? "Plan"), +fp.bedroom_count || 0, +fp.bathroom_count || 0, 0, "", []]);
  }
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

const READERS: Record<string, (cfg: any) => Promise<Model[]>> = { sightmap: readSightmap };

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const url = String(body.url || "");
  try {
    const { data: src } = await sb.from("sources").select("url, reader, reader_config, meta").eq("url", url).eq("active", true).maybeSingle();
    if (!src || !src.reader || !READERS[src.reader]) return json({ error: "Unknown source or no reader" }, 400);

    // Skip if refreshed in the last 12 hours (protects against repeated calls).
    const since = new Date(Date.now() - 12 * 3600e3).toISOString();
    const { data: recent } = await sb.from("sources").select("last_ok").eq("url", url).gte("last_ok", since).maybeSingle();
    if (recent) return json({ skipped: url });

    const models = await READERS[src.reader](src.reader_config);
    if (!models.length) throw new Error("Reader returned no available units");
    const data = { ...(src.meta ?? {}), models, reader: src.reader };
    const { error } = await sb.from("raw_scrapes").insert({ source_url: url, data });
    if (error) throw error;
    await sb.from("sources").update({ last_ok: new Date().toISOString(), last_error: null }).eq("url", url);
    return json({ ok: url, plans: models.length, units: models.reduce((a, m) => a + m[5].length, 0) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (url) await sb.from("sources").update({ last_error: msg.slice(0, 300) }).eq("url", url);
    return json({ error: msg }, 500);
  }
});
