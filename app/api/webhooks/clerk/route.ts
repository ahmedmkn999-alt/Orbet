// app/api/webhooks/clerk/route.ts
// Syncs Clerk user events to our Neon DB
// IMPORTANT: This runs on Node.js runtime (not Edge) for Svix signature verification
import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { prisma } from "@/lib/prisma";
import { cache } from "@/lib/redis";

export const runtime = "nodejs"; // Svix requires Node.js runtime

type ClerkUserEvent = {
  type:
    | "user.created"
    | "user.updated"
    | "user.deleted"
    | "session.created"
    | "session.ended";
  data: {
    id: string;
    username?: string;
    first_name?: string;
    last_name?: string;
    image_url?: string;
    email_addresses?: Array<{ email_address: string; id: string }>;
    deleted?: boolean;
  };
};

export async function POST(req: NextRequest) {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!WEBHOOK_SECRET) {
    throw new Error("CLERK_WEBHOOK_SECRET env var missing");
  }

  // Verify Svix signature
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing Svix headers" }, { status: 400 });
  }

  const payload = await req.text();

  let event: ClerkUserEvent;
  try {
    const wh = new Webhook(WEBHOOK_SECRET);
    event = wh.verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkUserEvent;
  } catch (err) {
    console.error("[Clerk Webhook] Invalid signature:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const { type, data } = event;

  try {
    switch (type) {
      case "user.created": {
        const username =
          data.username ??
          data.email_addresses?.[0]?.email_address.split("@")[0] ??
          `user_${data.id.slice(-8)}`;

        await prisma.user.create({
          data: {
            clerkId: data.id,
            username: username.toLowerCase().replace(/[^a-z0-9_-]/g, "_"),
            displayName:
              [data.first_name, data.last_name].filter(Boolean).join(" ") ||
              username,
            avatarUrl: data.image_url,
            status: "OFFLINE",
          },
        });

        console.log(`[Clerk Webhook] User created: ${data.id}`);
        break;
      }

      case "user.updated": {
        const updateData: Record<string, unknown> = {};

        if (data.first_name || data.last_name) {
          updateData.displayName = [data.first_name, data.last_name]
            .filter(Boolean)
            .join(" ");
        }

        if (data.image_url) {
          updateData.avatarUrl = data.image_url;
        }

        if (Object.keys(updateData).length > 0) {
          await prisma.user.update({
            where: { clerkId: data.id },
            data: updateData,
          });

          // Bust cache
          await cache.del(`user:clerk:${data.id}`);
        }

        break;
      }

      case "user.deleted": {
        // Soft delete - mark user but preserve messages
        await prisma.user
          .delete({ where: { clerkId: data.id } })
          .catch(() => {}); // Ignore if already deleted

        await cache.del(`user:clerk:${data.id}`);
        break;
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[Clerk Webhook] Processing error:", err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
