// ============================================================
// FAL ACCOUNT BILLING — real balance, usage history, and per-model
// pricing from Fal's own Platform API (https://api.fal.ai/v1/account/*
// and /v1/models/usage, /v1/models/pricing), NOT this app's own
// estimate-based ledger (see db.js). This is ground truth from Fal
// itself, not a guess.
//
// IMPORTANT: balance and usage-history both require an ADMIN-scoped API
// key — confirmed from Fal's own docs ("Admin API key must be prefixed
// with 'Key '"). This is a DIFFERENT key from the regular FAL_KEY used
// for inference calls throughout the rest of this app. If only a regular
// key is configured, these calls will fail with 401/403 — that's Fal's
// own permission model, not a bug here. An admin key is generated the
// same way as any other Fal API key, just with the admin scope selected.
//
// NOTE ON ADDING FUNDS: there is no Fal API for this. Confirmed via
// Fal's own FAQ: "Add credits from the billing dashboard to unlock your
// account" — topping up is a manual action through Fal's own billing
// page, not something exposed for third-party apps to embed. That's a
// deliberate payment-security boundary (no legitimate platform exposes
// a raw "charge this account" endpoint to arbitrary API keys), not a
// missing feature here. The best this app can do is a direct, one-click
// link to Fal's real billing page — see the "Add Funds" button in the UI.
// ============================================================

const API_BASE = "https://api.fal.ai/v1";

function adminAuthHeaders(adminKey) {
  const key = adminKey || process.env.FAL_ADMIN_KEY;
  if (!key) return null;
  return { Authorization: `Key ${key}` };
}

async function getRealBalance(adminKey) {
  const headers = adminAuthHeaders(adminKey);
  if (!headers) {
    return { available: false, reason: "No Fal Admin API Key configured — add one in Settings to see your real balance here (this is different from your regular inference API key)." };
  }
  const res = await fetch(`${API_BASE}/account/billing?expand=credits`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const status = res.status;
    const hint = status === 401 || status === 403 ? " (this usually means the key configured isn't admin-scoped — regular inference keys can't access billing data)" : "";
    return { available: false, reason: `Fal billing API returned ${status}${hint}: ${body.slice(0, 200)}` };
  }
  const data = await res.json();
  return { available: true, username: data.username, balance: data.credits?.current_balance ?? null, currency: data.credits?.currency || "USD" };
}

async function getRealUsage(adminKey, { start, end, cursor, limit = 100 } = {}) {
  const headers = adminAuthHeaders(adminKey);
  if (!headers) {
    return { available: false, reason: "No Fal Admin API Key configured — add one in Settings to see your real usage history here." };
  }
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(Math.min(limit, 200)));
  const res = await fetch(`${API_BASE}/models/usage?${params.toString()}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { available: false, reason: `Fal usage API returned ${res.status}: ${body.slice(0, 200)}` };
  }
  const data = await res.json();
  return { available: true, ...data };
}

// Pricing appears to work with a regular (non-admin) key per Fal's own
// docs example — kept separate from the admin-gated calls above.
async function getRealPricing(modelId, regularKey) {
  const key = regularKey || process.env.FAL_KEY;
  if (!key) return { available: false, reason: "No Fal API Key configured." };
  const res = await fetch(`${API_BASE}/models/pricing?endpoint_id=${encodeURIComponent(modelId)}`, {
    headers: { Authorization: `Key ${key}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { available: false, reason: `Fal pricing API returned ${res.status}: ${body.slice(0, 200)}` };
  }
  const data = await res.json();
  return { available: true, prices: data.prices || [] };
}

module.exports = { getRealBalance, getRealUsage, getRealPricing };
