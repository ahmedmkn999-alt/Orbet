// app/api/channels/[channelId]/typing/route.ts
// Lightweight typing indicator using Redis + Pusher
import { NextRequest } from "next/server";
import { pusherServer, pusherChannels, pusherEvents } from "@/lib/pusher";
import { typing, messageLimiter } from "@/lib/redis";
import { withAuth, verifyChannelMember, apiError, apiSuccess } from "@/middleware/auth";

export const runtime = "nodejs";

// ─── POST /api/channels/[channelId]/typing ────────────────────────────────────
// Client calls this when user starts/stops typing
export const POST = withAuth<{ channelId: string }>(
  async (req, { auth, params }) => {
    const { channelId } = params;

    const body = await req.json().catch(() => ({}));
    const isTyping = body.typing === true;

    const isMember = await verifyChannelMember(auth.userId, channelId);
    if (!isMember) return apiError.forbidden();

    if (isTyping) {
      await typing.setTyping(channelId, auth.userId);
    } else {
      await typing.clearTyping(channelId, auth.userId);
    }

    // Broadcast to channel (exclude sender using socket_id if available)
    const channelPusher = pusherChannels.channel(channelId);

    pusherServer
      .trigger(
        channelPusher,
        isTyping ? pusherEvents.TYPING_START : pusherEvents.TYPING_STOP,
        { userId: auth.userId }
      )
      .catch(console.error);

    return apiSuccess({ success: true });
  }
);

// ─── GET /api/channels/[channelId]/typing ─────────────────────────────────────
// Returns current list of users typing
export const GET = withAuth<{ channelId: string }>(
  async (_req, { auth, params }) => {
    const { channelId } = params;

    const isMember = await verifyChannelMember(auth.userId, channelId);
    if (!isMember) return apiError.forbidden();

    const typingUsers = await typing.getTyping(channelId);
    return apiSuccess({ typing: typingUsers });
  }
);
