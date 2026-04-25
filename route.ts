// app/api/pusher/auth/route.ts
// Authenticates users for private/presence Pusher channels
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { pusherServer } from "@/lib/pusher";
import { cache } from "@/lib/redis";
import { prisma } from "@/lib/prisma";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse Pusher auth request
  const body = await req.text();
  const params = new URLSearchParams(body);
  const socketId = params.get("socket_id");
  const channelName = params.get("channel_name");

  if (!socketId || !channelName) {
    return NextResponse.json({ error: "Missing socket_id or channel_name" }, { status: 400 });
  }

  // Resolve user from cache
  const cacheKey = `user:clerk:${clerkId}`;
  let user = await cache.get<{ id: string; username: string; displayName: string; avatarUrl: string | null }>(cacheKey);

  if (!user) {
    const dbUser = await prisma.user.findUnique({
      where: { clerkId },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });
    if (!dbUser) {
      return NextResponse.json({ error: "User not found" }, { status: 403 });
    }
    user = dbUser;
    await cache.set(cacheKey, user, 300);
  }

  // ─── Private channel auth ─────────────────────────────────────────────────
  if (channelName.startsWith("private-channel-")) {
    const channelId = channelName.replace("private-channel-", "");
    const memberKey = `member:${user.id}:${channelId}`;
    const isMember = await cache.get<boolean>(memberKey);

    if (isMember === false) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (isMember === null) {
      const membership = await prisma.channelMember.findUnique({
        where: { userId_channelId: { userId: user.id, channelId } },
        select: { id: true },
      });
      if (!membership) {
        await cache.set(memberKey, false, 60);
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      await cache.set(memberKey, true, 120);
    }

    const authResponse = pusherServer.authorizeChannel(socketId, channelName);
    return NextResponse.json(authResponse);
  }

  // ─── Presence channel auth ────────────────────────────────────────────────
  if (channelName.startsWith("presence-channel-")) {
    const channelId = channelName.replace("presence-channel-", "");
    const memberKey = `member:${user.id}:${channelId}`;
    const isMember = await cache.get<boolean>(memberKey);

    if (isMember === false) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const presenceData = {
      user_id: user.id,
      user_info: {
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
    };

    const authResponse = pusherServer.authorizeChannel(
      socketId,
      channelName,
      presenceData
    );
    return NextResponse.json(authResponse);
  }

  // ─── Private DM channel auth ──────────────────────────────────────────────
  if (channelName.startsWith("private-dm-")) {
    // DM channels are named: private-dm-{userId1}-{userId2} (sorted)
    const isParticipant = channelName.includes(user.id);
    if (!isParticipant) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const authResponse = pusherServer.authorizeChannel(socketId, channelName);
    return NextResponse.json(authResponse);
  }

  // ─── Private user channel auth ────────────────────────────────────────────
  if (channelName === `private-user-${user.id}`) {
    const authResponse = pusherServer.authorizeChannel(socketId, channelName);
    return NextResponse.json(authResponse);
  }

  return NextResponse.json({ error: "Unknown channel" }, { status: 400 });
}
