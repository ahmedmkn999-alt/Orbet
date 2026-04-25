// app/api/health/route.ts
// Vercel health check - used by uptime monitors
import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const start = Date.now();

  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

  // Check Redis
  try {
    await redis.ping();
    checks.redis = { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    checks.redis = { ok: false, error: "Redis unreachable" };
  }

  const allOk = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    {
      status: allOk ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? "1.0.0",
    },
    {
      status: allOk ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
