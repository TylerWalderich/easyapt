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

async function claude(content: unknown[], system: string, maxTokens = 1200): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }),
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
const TAG_SYSTEM = `You read rental floor plans (and listing photos or descriptions) for an apartment search engine.
Report only what the image or text actually shows. Floor plans often label rooms and dimensions such as "Balcony 12'x6'" or "Patio"; use them.
Reply with one JSON object and nothing else:
{"outdoor":{"type":one of ${JSON.stringify(OUTDOOR)},"size":one of ${JSON.stringify(SIZES)},"sqft":number or null,"count":number},
 "tags":[zero or more of ${JSON.stringify(TAGS)}],
 "summary":"one plain sentence, max 140 characters, naming the standout features"}
Outdoor size: small under 50 sq ft (a narrow balcony), medium 50-99, large 100 sq ft or more, or clearly the largest outdoor space a plan of this size would have (a wraparound or extra-deep terrace). If there is more than one outdoor space, describe the biggest and set count.
"terrace" means a large outdoor space; a normal balcony is "balcony". A private fenced yard is outdoor type "yard" plus tag "fenced_yard".
Use "corner_unit" only if windows clearly sit on two outside walls. Use "two_story" for plans with stairs between floors.`;

async function imagePart(url: string): Promise<unknown | null> {
  if (!url) return null;
  // Plain image links are passed by URL; anything else is downloaded and checked first.
  if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) return { type: "image", source: { type: "url", url } };
  return await imageInline(url);
}
async function imageInline(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 EasyApt" } });
    const type = (r.headers.get("content-type") ?? "").split(";")[0];
    if (!r.ok || !/^image\/(jpeg|png|gif|webp)$/.test(type)) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 4_500_000) return null;
    return { type: "image", source: { type: "base64", media_type: type, data: encodeBase64(buf) } };
  } catch { return null; }
}
function clean(f: any) {
  const o = f?.outdoor ?? {};
  return {
    outdoor: {
      type: OUTDOOR.includes(o.type) ? o.type : "none",
      size: SIZES.includes(o.size) ? o.size : (o.type && o.type !== "none" ? "small" : "none"),
      sqft: Number.isFinite(+o.sqft) && +o.sqft > 0 ? Math.round(+o.sqft) : null,
      count: Number.isFinite(+o.count) ? Math.max(0, Math.min(6, Math.round(+o.count))) : 0,
    },
    tags: [...new Set((Array.isArray(f?.tags) ? f.tags : []).filter((t: string) => TAGS.includes(t)))],
    summary: String(f?.summary ?? "").slice(0, 160),
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
Rental kinds are apartment, townhome, house.
Reply with one JSON object and nothing else:
{"groups":[{"label":"short human label, e.g. Large terrace","outdoor_types":[...] or [],"min_size":"small"|"medium"|"large"|null,"any_tags":[...] }],
 "kinds":[...] or [],
 "text":["leftover words that are names, e.g. a community or floor plan name"]}
Each group is one thing the renter asked for; a plan must satisfy every group. Inside a group, a plan matches if it has any of any_tags OR (outdoor type in outdoor_types with at least min_size).
Be generous with synonyms: "terrace" -> outdoor_types [terrace, balcony, patio, rooftop], min_size "medium"; "big/huge/large terrace" -> same types, min_size "large"; "balcony" -> [balcony, terrace], min_size "small"; "patio" -> [patio, terrace, courtyard, yard], min_size "small"; "yard" or "dog run" -> any_tags [fenced_yard, yard], outdoor_types [yard]; "office" or "work from home" -> any_tags [den_office, flex_room, loft]; "garage" -> [garage, attached_garage]; "big closet" -> [walk_in_closet, multiple_closets]; "island" -> [kitchen_island, breakfast_bar]; "washer dryer" or "laundry" -> [washer_dryer, laundry_room].
Words like "house", "townhome", "apartment" go in kinds, not groups. Ignore filler words. If nothing maps, return empty groups and put meaningful words in text.`;

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
    kinds: (p.kinds ?? []).filter((k: string) => ["apartment", "townhome", "house"].includes(k)),
    text: (p.text ?? []).map((t: unknown) => String(t).toLowerCase().slice(0, 40)).slice(0, 6),
  };
  await sb.from("query_parses").upsert({ q: key, parsed });
  return parsed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!AKEY) return json({ error: "AI key is not set (ANTHROPIC_API_KEY)" }, 503);
    const b = await req.json().catch(() => ({}));
    if (b.action === "parse") return json(await parse(String(b.q ?? "")));
    if (b.action === "tag") return json(await tagBatch(Math.min(Number(b.budget) || 110000, 120000)));
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
