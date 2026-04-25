// src/types/index.ts
// Shared TypeScript types for the chat backend

import type { User, Channel, Message, Attachment, Reaction, ChannelMember } from "@prisma/client";

// ─── API Response Types ───────────────────────────────────────────────────────

export type ApiResponse<T> = {
  data?: T;
  error?: string;
};

// ─── Enriched Message (what clients receive) ──────────────────────────────────
export type MessageWithDetails = Message & {
  sender: Pick<User, "id" | "username" | "displayName" | "avatarUrl">;
  attachments: Attachment[];
  reactions: Array<
    Reaction & {
      user: Pick<User, "id" | "username" | "avatarUrl">;
    }
  >;
  _count: { replies: number };
};

// ─── Channel with metadata ────────────────────────────────────────────────────
export type ChannelWithMeta = Channel & {
  myRole: ChannelMember["role"];
  lastReadAt: Date | null;
  lastMessage: {
    content: string | null;
    createdAt: Date;
    sender: Pick<User, "displayName">;
  } | null;
  _count: { members: number; messages: number };
};

// ─── Pusher Event Payloads ────────────────────────────────────────────────────
export type PusherNewMessagePayload = {
  message: MessageWithDetails;
  channelId: string;
};

export type PusherMessageUpdatedPayload = {
  message: MessageWithDetails;
};

export type PusherMessageDeletedPayload = {
  messageId: string;
  channelId: string;
};

export type PusherReactionPayload = {
  reaction: Reaction & {
    user: Pick<User, "id" | "username" | "avatarUrl">;
  };
  messageId: string;
};

export type PusherTypingPayload = {
  userId: string;
};

export type PusherPresencePayload = {
  userId: string;
  status: "online" | "away" | "offline";
};

// ─── Upload Types ──────────────────────────────────────────────────────────────
export type PresignResponse = {
  uploadUrl: string;    // PUT to this URL
  publicUrl: string;    // Reference this in messages
  key: string;
  expiresIn: number;
};

// ─── Pagination ───────────────────────────────────────────────────────────────
export type PaginatedResponse<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};
