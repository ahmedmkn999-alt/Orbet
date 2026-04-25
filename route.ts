// app/api/messages/[messageId]/reactions/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { pusherServer, pusherChannels, pusherEvents } from "@/lib/pusher";
import { withAuth, verifyChannelMember, apiError, apiSuccess } from "@/middleware/auth";

export const runtime = "edge";

const reactionSchema = z.object({
  emoji: z.string().emoji().max(8),
});

// ─── POST /api/messages/[messageId]/reactions ─────────────────────────────────
export const POST = withAuth<{ messageId: string }>(
  async (req, { auth, params }) => {
    let body: z.infer<typeof reactionSchema>;
    try {
      body = reactionSchema.parse(await req.json());
    } catch {
      return apiError.badRequest("Invalid emoji");
    }

    const message = await prisma.message.findFirst({
      where: { id: params.messageId, deletedAt: null },
      select: { channelId: true },
    });

    if (!message) return apiError.notFound("Message");

    const isMember = await verifyChannelMember(auth.userId, message.channelId);
    if (!isMember) return apiError.forbidden();

    // Upsert reaction (toggle behavior handled client-side by checking existing)
    const reaction = await prisma.reaction.upsert({
      where: {
        userId_messageId_emoji: {
          userId: auth.userId,
          messageId: params.messageId,
          emoji: body.emoji,
        },
      },
      create: {
        userId: auth.userId,
        messageId: params.messageId,
        emoji: body.emoji,
      },
      update: {}, // Already exists - no-op (client should DELETE instead)
      include: {
        user: { select: { id: true, username: true, avatarUrl: true } },
      },
    });

    pusherServer
      .trigger(
        pusherChannels.channel(message.channelId),
        pusherEvents.REACTION_ADDED,
        { reaction, messageId: params.messageId }
      )
      .catch(console.error);

    return apiSuccess(reaction, 201);
  }
);

// ─── DELETE /api/messages/[messageId]/reactions ───────────────────────────────
export const DELETE = withAuth<{ messageId: string }>(
  async (req, { auth, params }) => {
    const { searchParams } = new URL(req.url);
    const emoji = searchParams.get("emoji");

    if (!emoji) return apiError.badRequest("emoji query param required");

    const message = await prisma.message.findFirst({
      where: { id: params.messageId, deletedAt: null },
      select: { channelId: true },
    });

    if (!message) return apiError.notFound("Message");

    await prisma.reaction.deleteMany({
      where: {
        userId: auth.userId,
        messageId: params.messageId,
        emoji,
      },
    });

    pusherServer
      .trigger(
        pusherChannels.channel(message.channelId),
        pusherEvents.REACTION_REMOVED,
        { userId: auth.userId, messageId: params.messageId, emoji }
      )
      .catch(console.error);

    return apiSuccess({ success: true });
  }
);
