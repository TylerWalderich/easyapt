// EasyApt smart search: reads floor plans with AI and turns free-text keywords into features.
//   {action:"tag"}         tag floor plans that have no features yet (claimed atomically, never twice)
//   {action:"parse", q}    turn a shopper's keywords ("big terrace, garage") into feature filters (cached)
//   {action:"status", keys} how many of these plans are read so far
// Tags are written to plan_features, which the website reads directly.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { encodeBase64 } from "jsr:@std/encoding@1.0.5/base64";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const AKEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = "claude-haiku-5-5";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// The feature vocabulary. Tags are only ever drawn from this list so search can match them exactly.
export const TAGS = [
  "walk_in_closet", "multiple_closets", "kitchen_island", "breakfast_bar", "pantry", "dining_room", "open_concept",
  "den_office", "flex_room", "loft", "two_story", "garage", "attached_garage", "carport", "storage_room",
  "washer_dryer", "laundry_room", "fireplace", "double_vanity", "soaking_tub", "separate_tub_shower", "walk_in_shower",
  "ensuite_bath", "split_bedrooms", "half_bath", "corner_unit", "large_windows", "bay_window", "vaulted_ceilings",
  "private_entry", "yard", "fenced_yard", "pool", "accessible",
];
const OUTDOOR = ["none", "balcony", "patio", "terrace", "rooftop", "yard", "courtyard", "porch"];
const SIZES = ["none", "small", "medium", "large"];

async function claude(content: unknown[], system: string, maxTokens = 2500, messages?: unknown[]): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: messages ?? [{ role: "user", content }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${j?.error?.message ?? ""}`.slice(0, 300));
  return (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
}
function firstJson(t: string): any {
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no JSON in reply");
  return JSON.parse(t.slice(a, b + 1));
}

// ---------- Tagging ----------
const TAG_SYSTEM = `You read rental floor plans (and listing photos or descriptions) for a rental search engine.
Report only what the image or text actually shows. Be conservative: a wrong "large terrace" sends renters to the wrong apartment.
Work in this order and reply with one JSON object and nothing else:
{"rooms":[{"name":"living room","dims":"12'8\" x 14'8\"" or null}],
 "outdoor":{"type":one of ${JSON.stringify(OUTDOOR)},"dims":"dimension label printed INSIDE the outdoor space or naming it, else null","sqft":number or null,"depth_vs_room":"how deep the outdoor space looks compared with the room it opens from, e.g. about one third","size":one of ${JSON.stringify(SIZES)},"count":number},
 "tags":[zero or more of ${JSON.stringify(TAGS)}],
 "property_type":"house" | "townhome" | "loft" | "apartment" | "unknown",
 "summary":"one plain sentence, max 140 characters, naming the standout features"}
Property type, judged from the photo, the address and the description together:
- house: a detached single-family home, no shared walls.
- townhome: a home that shares a wall with a neighbor but has its own front door at ground level: townhouses, rowhouses, duplex/triplex/fourplex units (addresses ending in A, B, C or "Unit A"), patio homes in attached rows. A two-story attached unit with its own garage is a townhome.
- apartment: a unit in a multi-unit building reached by shared hallways or stairs, or a numbered unit in a larger complex; garage apartments and studios over garages count as apartments.
- loft: an apartment (entered from a shared hallway, breezeway or stairwell, no garage, no ground-level front door of its own) that is two-story in some way: a loft or mezzanine bedroom or den upstairs open to the room below, a second level inside the unit, or double-height ceilings (roughly 16-20 ft or more, "two-story living room", "open to below"). Plan names with "L" or "loft" (AL3, B2L) often signal this.
- For a floor plan drawing from an apartment community: "townhome" only when the unit is a full home on two or more floors with its own ground-level front door or an attached garage (often separate first-floor and second-floor panels showing an entry and garage); "loft" when it has an upper level or open loft but is otherwise an apartment; otherwise "apartment". Stairs drawn outside the unit's walls (a building stairwell or exterior steps) do not count.
- unknown: only when it is truly impossible to tell.
Rules for dimensions: a dimension label belongs to the indoor room it is printed in or beside. On most plans the labels next to a balcony belong to the living room or bedroom it opens from, not to the balcony. Only use a label for the outdoor space if it is printed inside the outdoor area or names it ("Balcony 6' x 10'", "Patio"). Otherwise leave outdoor.dims and outdoor.sqft null and judge size from proportions.
Outdoor size: small = a typical balcony or patio, roughly 5-7 ft deep or under 60 sq ft; medium = 60-99 sq ft, or noticeably deeper or wider than usual; large = 100 sq ft or more by a label that clearly belongs to it, or visibly at least half the size of the room it opens from, or wrapping a corner. When unsure between two sizes, choose the smaller.
"terrace" means a large outdoor space; a normal balcony is "balcony". A private fenced yard is outdoor type "yard" plus tag "fenced_yard".
Use "corner_unit" only if windows clearly sit on two outside walls. Use "two_story" only when the unit's own rooms are on two levels joined by an interior staircase; never for building or exterior stairs. Use "private_entry" when the unit has its own exterior front door.`;

async function imagePart(url: string): Promise<unknown | null> {
  if (!url) return null;
  // Plain image links are passed by URL; anything else is downloaded and checked first.
  // Includes links like ".../download?fileName=abc.jpeg&isPreview=true" (Buildium).
  if (/\.(jpe?g|png|gif|webp)(\?|&|$)/i.test(url)) return { type: "image", source: { type: "url", url } };
  return await imageInline(url);
}
async function imageInline(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 EasyApt" } });
    const type = (r.headers.get("content-type") ?? "").split(";")[0];
    if (!r.ok || !/^image\/(jpeg|png|gif|webp)$/.test(type)) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 1_500_000) return null; // keep memory low on the edge worker
    return { type: "image", source: { type: "base64", media_type: type, data: encodeBase64(buf) } };
  } catch { return null; }
}
function clean(f: any) {
  const o = f?.outdoor ?? {};
  return {
    outdoor: {
      type: OUTDOOR.includes(o.type) ? o.type : "none",
      size: SIZES.includes(o.size) ? o.size : (o.type && o.type !== "none" ? "small" : "none"),
      // A square footage is kept only when it came from a label that belongs to the outdoor space.
      sqft: o.dims && Number.isFinite(+o.sqft) && +o.sqft > 0 && +o.sqft < 2000 ? Math.round(+o.sqft) : null,
      count: Number.isFinite(+o.count) ? Math.max(0, Math.min(6, Math.round(+o.count))) : 0,
    },
    tags: [...new Set((Array.isArray(f?.tags) ? f.tags : []).filter((t: string) => TAGS.includes(t)))],
    summary: String(f?.summary ?? "").slice(0, 160),
    kind: ["house", "townhome", "loft", "apartment"].includes(f?.property_type) ? f.property_type : "unknown",
  };
}
async function tagOne(row: any) {
  const text = `Listing details: ${row.input_text ?? row.plan}`;
  try {
    let img = await imagePart(row.image_url);
    let reply: string;
    try {
      reply = await claude(img ? [img, { type: "text", text }] : [{ type: "text", text }], TAG_SYSTEM);
    } catch (e) {
      // Some image hosts refuse outside fetchers: send the image inline instead.
      if (!row.image_url || !/image|url|download|fetch/i.test(String(e))) throw e;
      img = await imageInline(row.image_url);
      reply = await claude(img ? [img, { type: "text", text }] : [{ type: "text", text }], TAG_SYSTEM);
    }
    const features = clean(firstJson(reply));
    await sb.from("plan_features").update({ features, model: MODEL, tagged_at: new Date().toISOString(), error: null }).eq("key", row.key);
    return true;
  } catch (e) {
    await sb.from("plan_features").update({ error: String(e).slice(0, 300), claimed_at: null }).eq("key", row.key);
    return false;
  }
}
async function tagBatch(budgetMs: number) {
  const until = Date.now() + budgetMs;
  let done = 0, failed = 0;
  while (Date.now() < until) {
    const { data, error } = await sb.rpc("claim_untagged", { n: 8 });
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    const res = await Promise.all(data.map(tagOne));
    done += res.filter(Boolean).length; failed += res.filter((x) => !x).length;
    if (failed > 12 && done === 0) break; // the API is failing: stop rather than burn attempts
  }
  return { done, failed };
}

// ---------- Keyword parsing ----------
const PARSE_SYSTEM = `You turn a renter's search keywords into filters for a rental search engine.
Floor plans are tagged with outdoor space {type in ${JSON.stringify(OUTDOOR.slice(1))}, size small|medium|large} and tags from ${JSON.stringify(TAGS)}.
Rental kinds are apartment, townhome, house, loft (a two-level apartment: loft bedroom upstairs, mezzanine, or double-height ceilings).
Reply with one JSON object and nothing else:
{"groups":[{"label":"short human label, e.g. Large terrace","outdoor_types":[...] or [],"min_size":"small"|"medium"|"large"|null,"any_tags":[...] }],
 "kinds":[...] or [],
 "text":["leftover words that are names, e.g. a community or floor plan name"]}
Each group is one thing the renter asked for; a plan must satisfy every group. Inside a group, a plan matches if it has any of any_tags OR (outdoor type in outdoor_types with at least min_size).
Be generous with synonyms: "terrace" -> outdoor_types [terrace, balcony, patio, rooftop], min_size "medium"; "big/huge/large terrace" -> same types, min_size "large"; "balcony" -> [balcony, terrace], min_size "small"; "patio" -> [patio, terrace, courtyard, yard], min_size "small"; "yard" or "dog run" -> any_tags [fenced_yard, yard], outdoor_types [yard]; "office" or "work from home" -> any_tags [den_office, flex_room, loft]; "garage" -> [garage, attached_garage]; "big closet" -> [walk_in_closet, multiple_closets]; "island" -> [kitchen_island, breakfast_bar]; "washer dryer" or "laundry" -> [washer_dryer, laundry_room].
Words like "house", "townhome", "apartment", "loft", "two story apartment", "high ceilings" go in kinds, not groups ("loft"/"two story apartment"/"20 ft ceilings" -> kinds ["loft"]). Ignore filler words. If nothing maps, return empty groups and put meaningful words in text.`;

async function parse(q: string) {
  const key = q.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
  if (!key) return { groups: [], kinds: [], text: [] };
  const { data } = await sb.from("query_parses").select("parsed").eq("q", key).maybeSingle();
  if (data) return data.parsed;
  const p = firstJson(await claude([{ type: "text", text: `Keywords: ${key}` }], PARSE_SYSTEM, 1500));
  const parsed = {
    groups: (Array.isArray(p.groups) ? p.groups : []).slice(0, 6).map((g: any) => ({
      label: String(g.label ?? "").slice(0, 40),
      outdoor_types: (g.outdoor_types ?? []).filter((t: string) => OUTDOOR.includes(t) && t !== "none"),
      min_size: ["small", "medium", "large"].includes(g.min_size) ? g.min_size : null,
      any_tags: (g.any_tags ?? []).filter((t: string) => TAGS.includes(t)),
    })).filter((g: any) => g.outdoor_types.length || g.any_tags.length),
    kinds: (p.kinds ?? []).filter((k: string) => ["apartment", "townhome", "house", "loft"].includes(k)),
    text: (p.text ?? []).map((t: unknown) => String(t).toLowerCase().slice(0, 40)).slice(0, 6),
  };
  await sb.from("query_parses").upsert({ q: key, parsed });
  return parsed;
}

// ---------- Furniture Test ----------
// Room sizes come only from dimension labels printed on the floor plan, so the to-scale planner is exact.
const ROOMS_SYSTEM = `You read the printed room dimension labels on a rental floor plan.
Reply with one JSON object and nothing else:
{"rooms":[{"name":"Primary bedroom","label":"12'9\\" x 11'0\\"","w_ft":12.75,"d_ft":11.0}],"note":"anything the renter should know, or empty"}
Include every room, closet, balcony or patio that has a printed dimension label; skip rooms without one. Name rooms the way a renter would (Living room, Bedroom 2, Walk-in closet, Balcony). w_ft is the first number, d_ft the second, converted to decimal feet. Never invent a dimension.`;

function parseFeet(v: unknown) { const n = Number(v); return Number.isFinite(n) && n > 1 && n < 80 ? Math.round(n * 100) / 100 : null; }

async function rooms(key: string) {
  const { data: row } = await sb.from("plan_features").select("key,image_url,rooms,plan").eq("key", key).maybeSingle();
  if (!row) throw new Error("floor plan not found");
  if (row.rooms) return { rooms: row.rooms.list ?? [], note: row.rooms.note ?? "", plan: row.plan, image: row.image_url };
  if (!row.image_url) return { rooms: [], note: "This floor plan has no drawing to measure.", plan: row.plan, image: null };
  const img = await imagePart(row.image_url);
  if (!img) return { rooms: [], note: "The floor plan drawing couldn't be loaded.", plan: row.plan, image: row.image_url };
  const p = firstJson(await claude([img, { type: "text", text: "List the labeled room dimensions on this floor plan." }], ROOMS_SYSTEM, 2000));
  const list = (Array.isArray(p.rooms) ? p.rooms : []).map((r: any) => ({
    name: String(r.name ?? "Room").slice(0, 40), label: String(r.label ?? "").slice(0, 30), w_ft: parseFeet(r.w_ft), d_ft: parseFeet(r.d_ft),
  })).filter((r: any) => r.w_ft && r.d_ft).slice(0, 20);
  const note = String(p.note ?? "").slice(0, 200);
  await sb.from("plan_features").update({ rooms: { list, note } }).eq("key", key);
  return { rooms: list, note, plan: row.plan, image: row.image_url };
}

const FURN_SYSTEM = (ctx: string) => `You are the Furniture Test assistant on EasyApt, a rental search site. A renter wants to know whether their furniture fits a specific floor plan.
${ctx}
When the renter describes, photographs or films furniture, identify each piece and its size in inches (width x depth x height; width is the long side seen from the front). Use the size they give if they give one. Otherwise estimate from the photo using standard sizes (queen bed 60x80, king 76x80, full 54x75, twin 38x75, California king 72x84; mattress sizes plus the frame if one is visible) and mark it estimated so they can measure to confirm. Put each new piece in the room the renter names, or the room where it normally goes.
Use the current layout and fit check above when answering fit questions: say exactly what fits, what doesn't, and the remaining walking room in inches. Renters usually want about 30-36 inches of walking space around beds and in front of sofas.
Keep replies short and friendly, at most 4 sentences. Never claim certainty about a size you estimated.
Reply with one JSON object and nothing else:
{"reply":"text shown to the renter","add":[{"name":"King bed","w":76,"d":80,"h":14,"room":"exact room name from the list","estimated":true}]}
"add" lists only NEW pieces from the renter's latest message; leave it empty otherwise.`;

async function furniture(b: any) {
  const ctx = String(b.context ?? "").slice(0, 4000);
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-16).map((m: any) => {
    const content: unknown[] = [];
    for (const img of (Array.isArray(m.images) ? m.images : []).slice(0, 4)) {
      const data = String(img).replace(/^data:image\/\w+;base64,/, "");
      if (data.length < 1_400_000) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    }
    content.push({ type: "text", text: String(m.text ?? "").slice(0, 2000) || "(photo)" });
    return { role: m.role === "assistant" ? "assistant" : "user", content: m.role === "assistant" ? String(m.text ?? "").slice(0, 2000) : content };
  });
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") throw new Error("no question");
  const p = firstJson(await claude([], FURN_SYSTEM(ctx), 1500, msgs));
  const add = (Array.isArray(p.add) ? p.add : []).slice(0, 12).map((x: any) => ({
    name: String(x.name ?? "Piece").slice(0, 40), w: Math.max(4, Math.min(240, +x.w || 0)), d: Math.max(4, Math.min(240, +x.d || 0)),
    h: Math.max(0, Math.min(144, +x.h || 0)), room: String(x.room ?? "").slice(0, 40), estimated: !!x.estimated,
  })).filter((x: any) => x.w && x.d);
  return { reply: String(p.reply ?? "").slice(0, 1200), add };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!AKEY) return json({ error: "AI key is not set (ANTHROPIC_API_KEY)" }, 503);
    const b = await req.json().catch(() => ({}));
    if (b.action === "parse") return json(await parse(String(b.q ?? "")));
    if (b.action === "tag") return json(await tagBatch(Math.min(Number(b.budget) || 110000, 120000)));
    if (b.action === "rooms") return json(await rooms(String(b.key ?? "")));
    if (b.action === "furniture") return json(await furniture(b));
    if (b.action === "status") {
      const keys = (Array.isArray(b.keys) ? b.keys : []).slice(0, 3000).map(String);
      let read = 0;
      for (let i = 0; i < keys.length; i += 300) {
        const { count } = await sb.from("plan_features").select("key", { count: "exact", head: true }).in("key", keys.slice(i, i + 300)).not("features", "is", null);
        read += count ?? 0;
      }
      return json({ total: keys.length, read });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
