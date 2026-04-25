// src/lib/redis.ts
// Upstash Redis - HTTP-based, works perfectly on Edge Runtime (no TCP needed)
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ─── Rate Limiters ────────────────────────────────────────────────────────────

// Strict limiter for message sending: 60 messages/minute per user
export const messageLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, "1 m"),
  analytics: true,
  prefix: "ratelimit:message",
});

// Looser limiter for read operations
export const readLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(300, "1 m"),
  analytics: true,
  prefix: "ratelimit:read",
});

// Upload presign requests: 20/minute
export const uploadLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, "1 m"),
  analytics: true,
  prefix: "ratelimit:upload",
});

// ─── Cache Helpers ─────────────────────────────────────────────────────────────

const DEFAULT_TTL = 60; // seconds

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    return redis.get<T>(key);
  },

  async set<T>(key: string, value: T, ttl = DEFAULT_TTL): Promise<void> {
    await redis.setex(key, ttl, value as any);
  },

  async del(key: string): Promise<void> {
    await redis.del(key);
  },

  async delPattern(pattern: string): Promise<void> {
    // Use SCAN to avoid blocking with KEYS
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  },

  // Cache keys factory - centralized to avoid typos
  keys: {
    channel: (id: string) => `channel:${id}`,
    channelMessages: (id: string, cursor?: string) =>
      `channel:${id}:messages:${cursor ?? "latest"}`,
    userPresence: (id: string) => `presence:${id}`,
    channelMembers: (id: string) => `channel:${id}:members`,
    userChannels: (userId: string) => `user:${userId}:channels`,
  },
};

// ─── Presence System ──────────────────────────────────────────────────────────

export const presence = {
  ONLINE_TTL: 90, // seconds before marked offline

  async setOnline(userId: string): Promise<void> {
    await redis.setex(
      cache.keys.userPresence(userId),
      presence.ONLINE_TTL,
      Date.now()
    );
  },

  async setOffline(userId: string): Promise<void> {
    await redis.del(cache.keys.userPresence(userId));
  },

  async isOnline(userId: string): Promise<boolean> {
    const ts = await redis.get(cache.keys.userPresence(userId));
    return ts !== null;
  },

  async heartbeat(userId: string): Promise<void> {
    // Reset TTL on heartbeat ping (called every ~60s from client)
    await redis.expire(cache.keys.userPresence(userId), presence.ONLINE_TTL);
  },

  async getBulk(userIds: string[]): Promise<Record<string, boolean>> {
    if (userIds.length === 0) return {};
    const pipeline = redis.pipeline();
    userIds.forEach((id) => pipeline.get(cache.keys.userPresence(id)));
    const results = await pipeline.exec();
    return userIds.reduce(
      (acc, id, i) => {
        acc[id] = results[i] !== null;
        return acc;
      },
      {} as Record<string, boolean>
    );
  },
};

// ─── Typing Indicators ────────────────────────────────────────────────────────

export const typing = {
  TTL: 5, // Auto-expire after 5s if no update

  key: (channelId: string) => `typing:${channelId}`,

  async setTyping(channelId: string, userId: string): Promise<void> {
    const key = typing.key(channelId);
    await redis.hset(key, { [userId]: Date.now() });
    await redis.expire(key, 30); // channel key TTL
  },

  async clearTyping(channelId: string, userId: string): Promise<void> {
    await redis.hdel(typing.key(channelId), userId);
  },

  async getTyping(channelId: string): Promise<string[]> {
    const all = await redis.hgetall<Record<string, number>>(
      typing.key(channelId)
    );
    if (!all) return [];
    const now = Date.now();
    // Filter out stale entries (> 5s old)
    return Object.entries(all)
      .filter(([, ts]) => now - ts < typing.TTL * 1000)
      .map(([userId]) => userId);
  },
};
