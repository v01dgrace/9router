/**
 * POST /api/nim/discover — Manual trigger for NIM model discovery + combo seeding.
 * GET  /api/nim/discover — Get current state (models, combos, last sync).
 */

import { NextResponse } from "next/server";
import {
  runNimDiscovery,
  getAllNimModels,
} from "open-sse/services/nvidiaDiscovery.js";
import { getProviderConnections } from "@/lib/localDb";

export async function POST() {
  try {
    const connections = await getProviderConnections({ provider: "nvidia", isActive: true });
    const apiKey = connections[0]?.apiKey || null;
    const result = await runNimDiscovery(apiKey);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("[NIM] Discovery POST error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    const models = await getAllNimModels();
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    let lastSyncAt = null;
    try {
      const row = db.get("SELECT value FROM _meta WHERE key = ?", ["lastNimSyncAt"]);
      lastSyncAt = row?.value || null;
    } catch { /* _meta table may not be bootstrapped yet */ }

    const combos = db
      .all("SELECT name, models FROM combos WHERE name LIKE 'nim-%'")
      .map((c) => ({ name: c.name, models: JSON.parse(c.models || "[]") }));

    const summary = {};
    for (const m of models) {
      const cat = m.category || "general";
      if (!summary[cat]) summary[cat] = { total: 0, active: 0, degraded: 0, tiers: {} };
      summary[cat].total++;
      if (m.status === "active") summary[cat].active++;
      else if (m.status === "degraded") summary[cat].degraded++;
      const tier = m.tier || "C";
      summary[cat].tiers[tier] = (summary[cat].tiers[tier] || 0) + 1;
    }

    return NextResponse.json({ models, combos, lastSyncAt, summary });
  } catch (error) {
    console.error("[NIM] Discovery GET error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}