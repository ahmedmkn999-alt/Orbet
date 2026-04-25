# ⚡ Chat Backend — Vercel Edge Architecture

> فائق السرعة، Zero-WebSocket، مبني بالكامل على Vercel Edge Functions

---

## 🏗️ Architecture Overview

```
Client
  │
  ├─► POST /api/messages          ← Edge Function (< 50ms response)
  │       │
  │       ├─ [1] Rate limit check    (Upstash Redis)
  │       ├─ [2] Auth verify         (Clerk JWT, cached in Redis)
  │       ├─ [3] Channel membership  (Redis cache → Neon fallback)
  │       ├─ [4] Write to Neon DB    (Prisma + pooled connection)
  │       ├─ [5] Invalidate cache    (Upstash Redis DEL)
  │       └─ [6] Trigger Pusher      (HTTP call, fire & forget)
  │                   │
  │                   └─► Pusher Channels ──► All connected clients receive message
  │
  ├─► PUT https://r2.cfusercontent.com/{key}   ← Direct from client (no server touch)
  │       ▲
  │       └─── GET /api/upload/presign generates signed URL first
  │
  └─► POST /api/presence           ← Heartbeat every 60s (Edge Function)
```

---

## 📁 Project Structure

```
├── app/api/
│   ├── messages/
│   │   ├── route.ts                # GET (list) + POST (send) messages
│   │   └── [messageId]/
│   │       ├── route.ts            # PATCH (edit) + DELETE
│   │       └── reactions/
│   │           └── route.ts        # POST + DELETE reactions
│   ├── channels/
│   │   ├── route.ts                # GET (list) + POST (create) channels
│   │   └── [channelId]/
│   │       └── typing/
│   │           └── route.ts        # POST (typing indicator)
│   ├── pusher/
│   │   └── auth/route.ts           # Pusher private/presence channel auth
│   ├── upload/
│   │   └── presign/route.ts        # R2 presigned URL generator
│   ├── presence/route.ts           # Heartbeat + bulk presence
│   ├── webhooks/
│   │   └── clerk/route.ts          # User sync from Clerk
│   └── health/route.ts             # Uptime check
├── src/
│   ├── lib/
│   │   ├── prisma.ts               # Prisma + Neon singleton
│   │   ├── redis.ts                # Upstash Redis + rate limiters + presence
│   │   └── pusher.ts               # Pusher server + client helpers
│   ├── middleware/
│   │   └── auth.ts                 # withAuth() HOF + error helpers
│   └── types/
│       └── index.ts                # Shared TypeScript types
├── prisma/
│   └── schema.prisma               # Neon PostgreSQL schema
├── middleware.ts                   # Clerk route protection
├── next.config.mjs                 # Edge-optimized Next.js config
└── .env.example                    # All required env vars
```

---

## 🚀 Setup & Deployment

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
```bash
cp .env.example .env.local
# Fill in all values (see sections below)
```

### 3. Set Up Neon DB
```bash
# Create project at neon.tech
# Copy pooled connection string → DATABASE_URL
# Copy direct connection string → DIRECT_URL

npm run db:push     # Push schema
# OR
npm run db:migrate  # With migration history
```

### 4. Configure Clerk
1. Create app at [clerk.com](https://clerk.com)
2. Copy publishable key → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
3. Copy secret key → `CLERK_SECRET_KEY`
4. Go to **Webhooks** → Add endpoint: `https://your-app.vercel.app/api/webhooks/clerk`
5. Subscribe to: `user.created`, `user.updated`, `user.deleted`
6. Copy signing secret → `CLERK_WEBHOOK_SECRET`

### 5. Configure Pusher Channels
1. Create app at [pusher.com](https://pusher.com)
2. Enable **Private Channels** and **Presence Channels**
3. Set auth endpoint: `https://your-app.vercel.app/api/pusher/auth`
4. Copy credentials to env vars

### 6. Configure Cloudflare R2
1. Create bucket at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Create R2 API token with `Object Read & Write` on your bucket
3. Enable **Public Access** or create a **Worker** for CDN URL
4. Copy credentials to env vars

### 7. Deploy to Vercel
```bash
npx vercel --prod
# Add all env vars in Vercel Dashboard → Settings → Environment Variables
```

---

## ⚡ Performance Decisions

| Decision | Reason |
|----------|--------|
| **Edge Runtime** on all routes | < 50ms cold start vs 500ms+ Node.js |
| **Prisma + Neon Serverless** | HTTP-based queries, no TCP connection overhead |
| **Upstash Redis (HTTP)** | Works on Edge (no TCP), global replication |
| **Pusher over WebSocket server** | No persistent server needed on Vercel |
| **Direct R2 Upload** | Server never handles file bytes, saves bandwidth + latency |
| **Fire-and-forget Pusher trigger** | Response returns immediately, push happens async |
| **Redis caching** | 95%+ of reads served from cache, DB only for misses |
| **Cursor-based pagination** | O(1) queries vs OFFSET which scans all rows |
| **Sliding window rate limit** | Prevents burst spam without blocking legitimate users |

---

## 🔒 Security Features

- **Clerk JWT verification** on every request via middleware
- **Svix webhook signature** validation for Clerk events  
- **Channel membership** verified before any read/write
- **Soft deletes** preserve audit trail
- **Rate limiting** on messages (60/min), reads (300/min), uploads (20/min)
- **MIME type allowlist** on uploads
- **File size limit** (100MB) enforced at presign time
- **Presigned URLs** expire in 15 minutes
- **Security headers** on all API responses

---

## 📡 Real-time Events Reference

| Event | Pusher Channel | Payload |
|-------|---------------|---------|
| `new-message` | `private-channel-{id}` | `{ message, channelId }` |
| `message-updated` | `private-channel-{id}` | `{ message }` |
| `message-deleted` | `private-channel-{id}` | `{ messageId, channelId }` |
| `reaction-added` | `private-channel-{id}` | `{ reaction, messageId }` |
| `reaction-removed` | `private-channel-{id}` | `{ userId, messageId, emoji }` |
| `typing-start` | `private-channel-{id}` | `{ userId }` |
| `typing-stop` | `private-channel-{id}` | `{ userId }` |
| `user-presence` | `presence-channel-{id}` | `{ userId, status }` |

---

## 🔌 Client Integration (Quick Reference)

```typescript
import { getPusherClient, pusherChannels, pusherEvents } from "@/lib/pusher";

// Subscribe to channel messages
const pusher = getPusherClient();
const channel = pusher.subscribe(`private-channel-${channelId}`);

channel.bind(pusherEvents.NEW_MESSAGE, (data) => {
  setMessages(prev => [data.message, ...prev]);
});

// Send a message
const res = await fetch("/api/messages", {
  method: "POST",
  body: JSON.stringify({ channelId, content: "Hello!" }),
});

// Upload a file (direct to R2)
const { uploadUrl, publicUrl } = await fetch("/api/upload/presign", {
  method: "POST",
  body: JSON.stringify({ filename: file.name, mimeType: file.type, size: file.size }),
}).then(r => r.json());

await fetch(uploadUrl, { method: "PUT", body: file });

// Then send message with attachment
await fetch("/api/messages", {
  method: "POST",
  body: JSON.stringify({
    channelId,
    attachments: [{ url: publicUrl, filename: file.name, mimeType: file.type, size: file.size, type: "IMAGE" }]
  }),
});
```
