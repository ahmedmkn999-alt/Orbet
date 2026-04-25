// src/lib/pusher.ts
// Pusher Channels - works perfectly with Vercel Edge (HTTP-based trigger API)
import PusherServer from "pusher";
import PusherClient from "pusher-js";

// ─── Server-side Pusher (for triggering events from API routes) ───────────────
export const pusherServer = new PusherServer({
  appId: process.env.PUSHER_APP_ID!,
  key: process.env.NEXT_PUBLIC_PUSHER_KEY!,
  secret: process.env.PUSHER_SECRET!,
  cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER!,
  useTLS: true,
});

// ─── Channel name factories ────────────────────────────────────────────────────
export const pusherChannels = {
  // Private channel per chat channel
  channel: (channelId: string) => `private-channel-${channelId}`,
  // Presence channel for online status
  presence: (channelId: string) => `presence-channel-${channelId}`,
  // Private DM channel (sorted IDs for consistency)
  dm: (userId1: string, userId2: string) => {
    const sorted = [userId1, userId2].sort();
    return `private-dm-${sorted[0]}-${sorted[1]}`;
  },
  // Global user notifications
  user: (userId: string) => `private-user-${userId}`,
};

// ─── Event name constants ─────────────────────────────────────────────────────
export const pusherEvents = {
  NEW_MESSAGE: "new-message",
  MESSAGE_UPDATED: "message-updated",
  MESSAGE_DELETED: "message-deleted",
  REACTION_ADDED: "reaction-added",
  REACTION_REMOVED: "reaction-removed",
  TYPING_START: "typing-start",
  TYPING_STOP: "typing-stop",
  USER_PRESENCE: "user-presence",
  CHANNEL_UPDATED: "channel-updated",
  MEMBER_JOINED: "member-joined",
  MEMBER_LEFT: "member-left",
} as const;

// ─── Batch event helper (reduces Pusher API calls) ────────────────────────────
export async function triggerBatch(
  events: Array<{
    channel: string;
    name: string;
    data: unknown;
  }>
) {
  // Pusher allows up to 10 events per batch
  const chunks = [];
  for (let i = 0; i < events.length; i += 10) {
    chunks.push(events.slice(i, i + 10));
  }

  await Promise.all(
    chunks.map((chunk) =>
      pusherServer.triggerBatch(
        chunk.map((e) => ({
          channel: e.channel,
          name: e.name,
          data: JSON.stringify(e.data),
        }))
      )
    )
  );
}

// ─── Client-side Pusher singleton (import in components) ─────────────────────
let pusherClientInstance: PusherClient | null = null;

export function getPusherClient(): PusherClient {
  if (typeof window === "undefined") {
    throw new Error("getPusherClient() must be called client-side only");
  }

  if (!pusherClientInstance) {
    pusherClientInstance = new PusherClient(
      process.env.NEXT_PUBLIC_PUSHER_KEY!,
      {
        cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER!,
        authEndpoint: "/api/pusher/auth",
        auth: {
          headers: {
            // Clerk auth token injected by middleware
            Authorization: `Bearer ${document.cookie
              .split("; ")
              .find((c) => c.startsWith("__session="))
              ?.split("=")[1]}`,
          },
        },
      }
    );
  }

  return pusherClientInstance;
}
