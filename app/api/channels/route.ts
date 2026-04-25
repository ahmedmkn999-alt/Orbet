// app/api/channels/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { cache, readLimiter } from "@/lib/redis";
import { withAuth, apiError, apiSuccess } from "@/middleware/auth";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const createChannelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-_]+$/, "Name must be lowercase alphanumeric, dashes, underscores only"),
  description: z.string().max(500).optional(),
  type: z.enum(["PUBLIC", "PRIVATE"]).default("PUBLIC"),
  memberIds: z.array(z.string().cuid()).max(500).optional(),
});

// ─── GET /api/channels ────────────────────────────────────────────────────────
export const GET = withAuth(async (req, { auth }) => {
  const { success } = await readLimiter.limit(auth.userId);
  if (!success) return apiError.rateLimit(Date.now() + 60000);

  const cacheKey = cache.keys.userChannels(auth.userId);
  const cached = await cache.get(cacheKey);
  if (cached) return apiSuccess(cached);

  const memberships = await prisma.channelMember.findMany({
    where: { userId: auth.userId },
    include: {
      channel: {
        include: {
          _count: { select: { members: true, messages: true } },
          messages: {
            take: 1,
            orderBy: { createdAt: "desc" },
            select: {
              content: true,
              createdAt: true,
              sender: { select: { displayName: true } },
            },
          },
        },
      },
    },
    orderBy: { channel: { updatedAt: "desc" } },
  });

  const channels = memberships.map(({ role, lastReadAt, channel }) => ({
    ...channel,
    myRole: role,
    lastReadAt,
    lastMessage: channel.messages[0] ?? null,
    messages: undefined, // Remove raw messages array
  }));

  await cache.set(cacheKey, channels, 60);
  return apiSuccess(channels);
});

// ─── POST /api/channels ───────────────────────────────────────────────────────
export const POST = withAuth(async (req, { auth }) => {
  let body: z.infer<typeof createChannelSchema>;
  try {
    body = createChannelSchema.parse(await req.json());
  } catch (err: any) {
    return apiError.badRequest(err.errors?.[0]?.message ?? "Invalid payload");
  }

  // Check slug uniqueness
  const slug = body.name.toLowerCase().replace(/\s+/g, "-");
  const existing = await prisma.channel.findUnique({ where: { slug } });
  if (existing) return apiError.badRequest("Channel name already taken");

  // Collect all member IDs (creator + specified members)
  const allMemberIds = [...new Set([auth.userId, ...(body.memberIds ?? [])])];

  // Verify all members exist
  if (body.memberIds?.length) {
    const users = await prisma.user.findMany({
      where: { id: { in: allMemberIds } },
      select: { id: true },
    });
    if (users.length !== allMemberIds.length) {
      return apiError.badRequest("One or more member IDs are invalid");
    }
  }

  const channel = await prisma.channel.create({
    data: {
      name: body.name,
      slug,
      description: body.description,
      type: body.type,
      members: {
        create: allMemberIds.map((userId) => ({
          userId,
          role: userId === auth.userId ? "OWNER" : "MEMBER",
        })),
      },
    },
    include: {
      _count: { select: { members: true } },
    },
  });

  // Invalidate user channels cache for all new members
  await cache.delPattern(`user:*:channels`);

  return apiSuccess(channel, 201);
});
