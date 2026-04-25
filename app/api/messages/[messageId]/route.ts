// app/api/messages/[messageId]/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { cache } from "@/lib/redis";
import { pusherServer, pusherChannels, pusherEvents } from "@/lib/pusher";
import {
  withAuth,
  apiError,
  apiSuccess,
} from "@/middleware/auth";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  content: z.string().min(1).max(4000),
});

// ─── PATCH /api/messages/[messageId] ─────────────────────────────────────────
export const PATCH = withAuth<{ messageId: string }>(
  async (req, { auth, params }) => {
    const { messageId } = params;

    let body: z.infer<typeof updateSchema>;
    try {
      body = updateSchema.parse(await req.json());
    } catch {
      return apiError.badRequest("Invalid payload");
    }

    // Fetch message to check ownership
    const message = await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null },
      select: { senderId: true, channelId: true, type: true },
    });

    if (!message) return apiError.notFound("Message");
    if (message.senderId !== auth.userId) return apiError.forbidden();
    if (message.type !== "TEXT") return apiError.badRequest("Cannot edit non-text messages");

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        content: body.content,
        editedAt: new Date(),
      },
      include: {
        sender: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
        attachments: true,
        reactions: true,
      },
    });

    // Invalidate cache & push update
    await cache.delPattern(`channel:${message.channelId}:messages:*`);

    pusherServer
      .trigger(
        pusherChannels.channel(message.channelId),
        pusherEvents.MESSAGE_UPDATED,
        { message: updated }
      )
      .catch(console.error);

    return apiSuccess(updated);
  }
);

// ─── DELETE /api/messages/[messageId] ────────────────────────────────────────
export const DELETE = withAuth<{ messageId: string }>(
  async (_req, { auth, params }) => {
    const { messageId } = params;

    const message = await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null },
      select: { senderId: true, channelId: true },
    });

    if (!message) return apiError.notFound("Message");
    if (message.senderId !== auth.userId) return apiError.forbidden();

    // Soft delete - preserve DB record for audit trail
    await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), content: null },
    });

    await cache.delPattern(`channel:${message.channelId}:messages:*`);

    pusherServer
      .trigger(
        pusherChannels.channel(message.channelId),
        pusherEvents.MESSAGE_DELETED,
        { messageId, channelId: message.channelId }
      )
      .catch(console.error);

    return apiSuccess({ success: true });
  }
);
