// app/api/presence/route.ts
// Lightweight presence system - clients ping every 60s to stay "online"
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { presence, cache } from "@/lib/redis";
import { pusherServer, pusherChannels, pusherEvents } from "@/lib/pusher";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

// ─── POST /api/presence ───────────────────────────────────────────────────────
// Heartbeat endpoint - client calls every ~60s
export async function POST(req: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cacheKey = `user:clerk:${clerkId}`;
  let user = await cache.get<{ id: string }>(cacheKey);

  if (!user) {
    const dbUser = await prisma.user.findUnique({
      where: { clerkId },
      select: { id: true },
    });
    if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });
    user = dbUser;
  }

  const wasOnline = await presence.isOnline(user.id);
  await presence.heartbeat(user.id);

  // Update DB last seen
  await prisma.user.update({
    where: { id: user.id },
    data: { lastSeenAt: new Date(), status: "ONLINE" },
  });

  // Only broadcast if transitioning from offline → online
  if (!wasOnline) {
    const channelIds = await getUserChannelIds(user.id);
    if (channelIds.length > 0) {
      await pusherServer.triggerBatch(
        channelIds.slice(0, 10).map((channelId) => ({
          channel: pusherChannels.presence(channelId),
          name: pusherEvents.USER_PRESENCE,
          data: JSON.stringify({ userId: user!.id, status: "online" }),
        }))
      );
    }
  }

  return NextResponse.json({ status: "online", ttl: 90 });
}

// ─── DELETE /api/presence ─────────────────────────────────────────────────────
// Called on disconnect / tab close (best-effort via sendBeacon)
export async function DELETE(req: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({}, { status: 401 });

  const cacheKey = `user:clerk:${clerkId}`;
  const user = await cache.get<{ id: string }>(cacheKey);
  if (!user) return NextResponse.json({ success: true });

  await presence.setOffline(user.id);
  await prisma.user.update({
    where: { id: user.id },
    data: { status: "OFFLINE", lastSeenAt: new Date() },
  });

  const channelIds = await getUserChannelIds(user.id);
  if (channelIds.length > 0) {
    await pusherServer.triggerBatch(
      channelIds.slice(0, 10).map((channelId) => ({
        channel: pusherChannels.presence(channelId),
        name: pusherEvents.USER_PRESENCE,
        data: JSON.stringify({ userId: user.id, status: "offline" }),
      }))
    );
  }

  return NextResponse.json({ success: true });
}

// ─── GET /api/presence?userIds=id1,id2 ───────────────────────────────────────
export async function GET(req: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const userIds = (searchParams.get("userIds") ?? "").split(",").filter(Boolean).slice(0, 100);

  if (userIds.length === 0) {
    return NextResponse.json({ presence: {} });
  }

  const presenceMap = await presence.getBulk(userIds);
  return NextResponse.json({ presence: presenceMap });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getUserChannelIds(userId: string): Promise<string[]> {
  const cacheKey = `user:${userId}:channelIds`;
  const cached = await cache.get<string[]>(cacheKey);
  if (cached) return cached;

  const memberships = await prisma.channelMember.findMany({
    where: { userId },
    select: { channelId: true },
  });

  const ids = memberships.map((m) => m.channelId);
  await cache.set(cacheKey, ids, 300);
  return ids;
}
