// EasyApt place suggestions for "Search by proximity": POST {q, session} -> [{id, main, sub}]
// Uses Google Places Autocomplete (New). The session token groups a person's keystrokes with the
// place lookup the search does afterwards, which is how Google bills one typing session.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GKEY = Deno.env.get("GOOGLE_PLACES_KEY") ?? "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const b = await req.json().catch(() => ({}));
  const q = String(b.q ?? "").trim().slice(0, 120);
  const session = /^[A-Za-z0-9-]{8,64}$/.test(String(b.session ?? "")) ? String(b.session) : undefined;
  if (q.length < 2) return json([]);
  const body: Record<string, unknown> = { input: q, includedRegionCodes: ["us"], languageCode: "en" };
  if (session) body.sessionToken = session;
  // Lean toward where the person is searching from, when the page knows it (e.g. the last search's place).
  const lat = +b.lat, lng = +b.lng;
  if (Number.isFinite(lat) && Number.isFinite(lng) && b.lat != null) body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } };
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GKEY, "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.text" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.message ?? `HTTP ${r.status}` }, 502);
    return json((j.suggestions ?? []).map((s: any) => s.placePrediction).filter(Boolean).slice(0, 6).map((p: any) => ({
      id: p.placeId,
      main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
      sub: (p.structuredFormat?.secondaryText?.text ?? "").replace(/,\s*USA$/, ""),
    })));
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 502);
  }
});
