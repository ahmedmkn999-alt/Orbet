// app/api/pusher/auth/route.ts
// Node.js runtime (NOT Edge) — pusher auth needs crypto for HMAC signing
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cache } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

export const runtime = "nodejs"; // Must be Node.js for crypto
export const dynamic = "force-dynamic";

function pusherAuth(
  socketId: string,
  channel: string,
  presenceData?: object
): { auth: string; channel_data?: string } {
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY!;
  const secret = process.env.PUSHER_SECRET!;

  const channelData = presenceData ? JSON.stringify(presenceData) : undefined;
  const toSign = channelData
    ? `${socketId}:${channel}:${channelData}`
    : `${socketId}:${channel}`;

  const signature = crypto.createHmac("sha256", secret).update(toSign).digest("hex");

  return {
    auth: `${key}:${signature}`,
    ...(channelData ? { channel_data: channelData } : {}),
  };
}

export async function POST(req: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.text();
  const params = new URLSearchParams(body);
  const socketId = params.get("socket_id");
  const channelName = params.get("channel_name");

  if (!socketId || !channelName) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  // Resolve user
  const cacheKey = `user:clerk:${clerkId}`;
  let user = await cache.get<{ id: string; username: string; displayName: string; avatarUrl: string | null }>(cacheKey);

  if (!user) {
    const dbUser = await prisma.user.findUnique({
      where: { clerkId },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });
    if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
    user = dbUser;
    await cache.set(cacheKey, user, 300);
  }

  // ─── Private channel ──────────────────────────────────────────────────────
  if (channelName.startsWith("private-channel-")) {
    const channelId = channelName.replace("private-channel-", "");
    const memberKey = `member:${user.id}:${channelId}`;
    let isMember = await cache.get<boolean>(memberKey);

    if (isMember === null) {
      const membership = await prisma.channelMember.findUnique({
        where: { userId_channelId: { userId: user.id, channelId } },
        select: { id: true },
      });
      isMember = membership !== null;
      await cache.set(memberKey, isMember, 120);
    }

    if (!isMember) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    return NextResponse.json(pusherAuth(socketId, channelName));
  }

  // ─── Presence channel ─────────────────────────────────────────────────────
  if (channelName.startsWith("presence-channel-")) {
    const channelId = channelName.replace("presence-channel-", "");
    const memberKey = `member:${user.id}:${channelId}`;
    let isMember = await cache.get<boolean>(memberKey);

    if (isMember === null) {
      const membership = await prisma.channelMember.findUnique({
        where: { userId_channelId: { userId: user.id, channelId } },
        select: { id: true },
      });
      isMember = membership !== null;
      await cache.set(memberKey, isMember, 120);
    }

    if (!isMember) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    return NextResponse.json(
      pusherAuth(socketId, channelName, {
        user_id: user.id,
        user_info: { username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl },
      })
    );
  }

  // ─── DM channel ───────────────────────────────────────────────────────────
  if (channelName.startsWith("private-dm-") && channelName.includes(user.id)) {
    return NextResponse.json(pusherAuth(socketId, channelName));
  }

  // ─── User private channel ─────────────────────────────────────────────────
  if (channelName === `private-user-${user.id}`) {
    return NextResponse.json(pusherAuth(socketId, channelName));
  }

  return NextResponse.json({ error: "Unknown channel" }, { status: 400 });
          }
