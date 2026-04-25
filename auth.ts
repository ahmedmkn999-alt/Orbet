// src/middleware/auth.ts
// Clerk-based authentication helpers for Edge Runtime API routes
import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cache } from "@/lib/redis";

export type AuthContext = {
  userId: string;      // Internal DB user ID
  clerkId: string;     // Clerk user ID
  username: string;
};

// ─── Core auth guard ──────────────────────────────────────────────────────────
// Wrap any API handler with this to enforce authentication
export function withAuth<T extends Record<string, string> = {}>(
  handler: (
    req: NextRequest,
    ctx: { auth: AuthContext; params: T }
  ) => Promise<Response>
) {
  return async (req: NextRequest, { params }: { params: T }) => {
    try {
      const { userId: clerkId } = await auth();

      if (!clerkId) {
        return NextResponse.json(
          { error: "Unauthorized" },
          { status: 401 }
        );
      }

      // Resolve internal user (cached aggressively)
      const user = await resolveUser(clerkId);

      if (!user) {
        return NextResponse.json(
          { error: "User not found. Please complete onboarding." },
          { status: 403 }
        );
      }

      return handler(req, {
        auth: { userId: user.id, clerkId, username: user.username },
        params,
      });
    } catch (err) {
      console.error("[Auth Error]", err);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  };
}

// ─── User resolution with Redis cache ────────────────────────────────────────
async function resolveUser(clerkId: string) {
  const cacheKey = `user:clerk:${clerkId}`;

  // Try cache first (5 min TTL)
  const cached = await cache.get<{ id: string; username: string }>(cacheKey);
  if (cached) return cached;

  // Fallback to DB
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true, username: true },
  });

  if (user) {
    await cache.set(cacheKey, user, 300); // 5 min
  }

  return user;
}

// ─── Channel membership guard ─────────────────────────────────────────────────
export async function verifyChannelMember(
  userId: string,
  channelId: string
): Promise<boolean> {
  const cacheKey = `member:${userId}:${channelId}`;
  const cached = await cache.get<boolean>(cacheKey);
  if (cached !== null) return cached;

  const member = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId, channelId } },
    select: { id: true },
  });

  const isMember = member !== null;
  await cache.set(cacheKey, isMember, 120); // 2 min
  return isMember;
}

// ─── Error response helpers ───────────────────────────────────────────────────
export const apiError = {
  unauthorized: () =>
    NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  forbidden: () =>
    NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  notFound: (resource = "Resource") =>
    NextResponse.json({ error: `${resource} not found` }, { status: 404 }),
  rateLimit: (reset: number) =>
    NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(reset),
          "X-RateLimit-Reset": String(reset),
        },
      }
    ),
  badRequest: (message: string) =>
    NextResponse.json({ error: message }, { status: 400 }),
  internal: () =>
    NextResponse.json({ error: "Internal server error" }, { status: 500 }),
};

// ─── JSON response helper ─────────────────────────────────────────────────────
export function apiSuccess<T>(data: T, status = 200): Response {
  return NextResponse.json(data, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
