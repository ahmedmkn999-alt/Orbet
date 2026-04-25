// app/api/messages/route.ts
// Edge Runtime - handles message creation, DB write, and Pusher trigger
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { cache, messageLimiter, typing } from "@/lib/redis";
import { pusherServer, pusherChannels, pusherEvents } from "@/lib/pusher";
import {
  withAuth,
  verifyChannelMember,
  apiError,
  apiSuccess,
} from "@/middleware/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Validation Schema ────────────────────────────────────────────────────────
const sendMessageSchema = z.object({
  channelId: z.string().cuid(),
  content: z.string().min(1).max(4000).optional(),
  parentId: z.string().cuid().optional(),
  attachments: z
    .array(
      z.object({
        url: z.string().url(),
        filename: z.string().max(255),
        mimeType: z.string().max(100),
        size: z.number().int().positive().max(100_000_000), // 100MB max
        type: z.enum(["IMAGE", "VIDEO", "AUDIO", "FILE"]),
        width: z.number().optional(),
        height: z.number().optional(),
        duration: z.number().optional(),
      })
    )
    .max(10)
    .optional(),
});

// ─── POST /api/messages ────────────────────────────────────────────────────────
export const POST = withAuth(async (req, { auth }) => {
  // 1. Rate limit check (per user)
  const { success, reset } = await messageLimiter.limit(auth.userId);
  if (!success) return apiError.rateLimit(reset);

  // 2. Parse & validate body
  let body: z.infer<typeof sendMessageSchema>;
  try {
    body = sendMessageSchema.parse(await req.json());
  } catch (err) {
    return apiError.badRequest("Invalid message payload");
  }

  // Must have content or attachments
  if (!body.content && (!body.attachments || body.attachments.length === 0)) {
    return apiError.badRequest("Message must have content or attachments");
  }

  // 3. Verify channel membership (cached)
  const isMember = await verifyChannelMember(auth.userId, body.channelId);
  if (!isMember) return apiError.forbidden();

  // 4. Validate parent message exists in same channel (if replying)
  if (body.parentId) {
    const parent = await prisma.message.findFirst({
      where: {
        id: body.parentId,
        channelId: body.channelId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!parent) return apiError.notFound("Parent message");
  }

  // 5. Create message + attachments in a transaction
  const type =
    body.attachments && body.attachments.length > 0 && !body.content
      ? "ATTACHMENT"
      : "TEXT";

  const message = await prisma.message.create({
    data: {
      content: body.content,
      type,
      senderId: auth.userId,
      channelId: body.channelId,
      parentId: body.parentId,
      attachments: body.attachments
        ? {
            create: body.attachments.map((a) => ({
              url: a.url,
              filename: a.filename,
              mimeType: a.mimeType,
              size: a.size,
              type: a.type,
              width: a.width,
              height: a.height,
              duration: a.duration,
            })),
          }
        : undefined,
    },
    include: {
      sender: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
      },
      attachments: true,
      reactions: true,
      _count: { select: { replies: true } },
    },
  });

  // 6. Invalidate channel messages cache
  await cache.delPattern(`channel:${body.channelId}:messages:*`);

  // 7. Clear typing indicator for this user
  await typing.clearTyping(body.channelId, auth.userId);

  // 8. Push real-time event via Pusher (fire and forget for speed)
  const pusherChannel = pusherChannels.channel(body.channelId);

  // Don't await - push async while we return response
  pusherServer
    .trigger(pusherChannel, pusherEvents.NEW_MESSAGE, {
      message,
      channelId: body.channelId,
    })
    .catch((err) => console.error("[Pusher] Trigger failed:", err));

  return apiSuccess(message, 201);
});

// ─── GET /api/messages?channelId=...&cursor=... ──────────────────────────────
export const GET = withAuth(async (req, { auth }) => {
  const { searchParams } = new URL(req.url);
  const channelId = searchParams.get("channelId");
  const cursor = searchParams.get("cursor") ?? undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 100);

  if (!channelId) return apiError.badRequest("channelId is required");

  const isMember = await verifyChannelMember(auth.userId, channelId);
  if (!isMember) return apiError.forbidden();

  // Cache key includes cursor for pagination
  const cacheKey = cache.keys.channelMessages(channelId, cursor);
  const cachedMessages = await cache.get(cacheKey);
  if (cachedMessages) {
    return apiSuccess(cachedMessages);
  }

  const messages = await prisma.message.findMany({
    where: {
      channelId,
      parentId: null,          // Only top-level messages (threads fetched separately)
      deletedAt: null,
    },
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      sender: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
      },
      attachments: true,
      reactions: {
        include: {
          user: { select: { id: true, username: true, avatarUrl: true } },
        },
      },
      _count: { select: { replies: true } },
    },
  });

  const nextCursor = messages.length === limit ? messages[messages.length - 1]?.id : null;
  const result = { messages, nextCursor };

  // Cache for 30 seconds (invalidated on new message)
  await cache.set(cacheKey, result, 30);

  return apiSuccess(result);
});
                                    
