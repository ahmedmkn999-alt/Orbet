// src/lib/pusher.ts
// Edge-compatible Pusher trigger — uses Web Crypto API (no Node.js 'crypto' module)
// يعمل على Edge Runtime بدون أي مشاكل

// ─── Channel name factories ────────────────────────────────────────────────────
export const pusherChannels = {
  channel: (channelId: string) => `private-channel-${channelId}`,
  presence: (channelId: string) => `presence-channel-${channelId}`,
  dm: (userId1: string, userId2: string) => {
    const sorted = [userId1, userId2].sort();
    return `private-dm-${sorted[0]}-${sorted[1]}`;
  },
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

// ─── Web Crypto HMAC-SHA256 (Edge-compatible) ─────────────────────────────────
async function hmacSHA256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function md5(str: string): string {
  // Pusher requires MD5 of body — use a simple implementation
  // since Web Crypto doesn't support MD5 directly
  // For Pusher's body_md5, we use a pure-JS implementation
  return md5Impl(str);
}

// Pure JS MD5 for Edge Runtime
function md5Impl(str: string): string {
  function safeAdd(x: number, y: number) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function bitRotateLeft(num: number, cnt: number) {
    return (num << cnt) | (num >>> (32 - cnt));
  }
  function md5cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function md5ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return md5cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function md5gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function md5hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return md5cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function md5ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return md5cmn(c ^ (b | ~d), a, b, x, s, t);
  }

  const bytes = new TextEncoder().encode(str);
  const len8 = bytes.length;
  const len32 = Math.ceil((len8 + 9) / 64) * 16;
  const M = new Int32Array(len32);
  for (let i = 0; i < len8; i++) M[i >> 2] |= bytes[i] << ((i % 4) * 8);
  M[len8 >> 2] |= 0x80 << ((len8 % 4) * 8);
  M[len32 - 2] = len8 * 8;

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < len32; i += 16) {
    const [aa, bb, cc, dd] = [a, b, c, d];
    a = md5ff(a,b,c,d,M[i],7,-680876936); d=md5ff(d,a,b,c,M[i+1],12,-389564586); c=md5ff(c,d,a,b,M[i+2],17,606105819); b=md5ff(b,c,d,a,M[i+3],22,-1044525330);
    a = md5ff(a,b,c,d,M[i+4],7,-176418897); d=md5ff(d,a,b,c,M[i+5],12,1200080426); c=md5ff(c,d,a,b,M[i+6],17,-1473231341); b=md5ff(b,c,d,a,M[i+7],22,-45705983);
    a = md5ff(a,b,c,d,M[i+8],7,1770035416); d=md5ff(d,a,b,c,M[i+9],12,-1958414417); c=md5ff(c,d,a,b,M[i+10],17,-42063); b=md5ff(b,c,d,a,M[i+11],22,-1990404162);
    a = md5ff(a,b,c,d,M[i+12],7,1804603682); d=md5ff(d,a,b,c,M[i+13],12,-40341101); c=md5ff(c,d,a,b,M[i+14],17,-1502002290); b=md5ff(b,c,d,a,M[i+15],22,1236535329);
    a = md5gg(a,b,c,d,M[i+1],5,-165796510); d=md5gg(d,a,b,c,M[i+6],9,-1069501632); c=md5gg(c,d,a,b,M[i+11],14,643717713); b=md5gg(b,c,d,a,M[i],20,-373897302);
    a = md5gg(a,b,c,d,M[i+5],5,-701558691); d=md5gg(d,a,b,c,M[i+10],9,38016083); c=md5gg(c,d,a,b,M[i+15],14,-660478335); b=md5gg(b,c,d,a,M[i+4],20,-405537848);
    a = md5gg(a,b,c,d,M[i+9],5,568446438); d=md5gg(d,a,b,c,M[i+14],9,-1019803690); c=md5gg(c,d,a,b,M[i+3],14,-187363961); b=md5gg(b,c,d,a,M[i+8],20,1163531501);
    a = md5gg(a,b,c,d,M[i+13],5,-1444681467); d=md5gg(d,a,b,c,M[i+2],9,-51403784); c=md5gg(c,d,a,b,M[i+7],14,1735328473); b=md5gg(b,c,d,a,M[i+12],20,-1926607734);
    a = md5hh(a,b,c,d,M[i+5],4,-378558); d=md5hh(d,a,b,c,M[i+8],11,-2022574463); c=md5hh(c,d,a,b,M[i+11],16,1839030562); b=md5hh(b,c,d,a,M[i+14],23,-35309556);
    a = md5hh(a,b,c,d,M[i+1],4,-1530992060); d=md5hh(d,a,b,c,M[i+4],11,1272893353); c=md5hh(c,d,a,b,M[i+7],16,-155497632); b=md5hh(b,c,d,a,M[i+10],23,-1094730640);
    a = md5hh(a,b,c,d,M[i+13],4,681279174); d=md5hh(d,a,b,c,M[i],11,-358537222); c=md5hh(c,d,a,b,M[i+3],16,-722521979); b=md5hh(b,c,d,a,M[i+6],23,76029189);
    a = md5hh(a,b,c,d,M[i+9],4,-640364487); d=md5hh(d,a,b,c,M[i+12],11,-421815835); c=md5hh(c,d,a,b,M[i+15],16,530742520); b=md5hh(b,c,d,a,M[i+2],23,-995338651);
    a = md5ii(a,b,c,d,M[i],6,-198630844); d=md5ii(d,a,b,c,M[i+7],10,1126891415); c=md5ii(c,d,a,b,M[i+14],15,-1416354905); b=md5ii(b,c,d,a,M[i+5],21,-57434055);
    a = md5ii(a,b,c,d,M[i+12],6,1700485571); d=md5ii(d,a,b,c,M[i+3],10,-1894986606); c=md5ii(c,d,a,b,M[i+10],15,-1051523); b=md5ii(b,c,d,a,M[i+1],21,-2054922799);
    a = md5ii(a,b,c,d,M[i+8],6,1873313359); d=md5ii(d,a,b,c,M[i+15],10,-30611744); c=md5ii(c,d,a,b,M[i+6],15,-1560198380); b=md5ii(b,c,d,a,M[i+13],21,1309151649);
    a = md5ii(a,b,c,d,M[i+4],6,-145523070); d=md5ii(d,a,b,c,M[i+11],10,-1120210379); c=md5ii(c,d,a,b,M[i+2],15,718787259); b=md5ii(b,c,d,a,M[i+9],21,-343485551);
    a=safeAdd(a,aa); b=safeAdd(b,bb); c=safeAdd(c,cc); d=safeAdd(d,dd);
  }

  return [a, b, c, d]
    .map((n) =>
      Array.from({ length: 4 }, (_, i) => ((n >> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join("")
    )
    .join("");
}

// ─── Pusher HTTP Trigger (Edge-compatible) ────────────────────────────────────
export const pusherServer = {
  async trigger(channel: string, event: string, data: unknown): Promise<void> {
    await triggerBatch([{ channel, name: event, data }]);
  },

  async triggerBatch(
    events: Array<{ channel: string; name: string; data: string }>
  ): Promise<void> {
    const appId = process.env.PUSHER_APP_ID!;
    const key = process.env.NEXT_PUBLIC_PUSHER_KEY!;
    const secret = process.env.PUSHER_SECRET!;
    const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER!;

    const body = JSON.stringify({
      batch: events.map((e) => ({
        channel: e.channel,
        name: e.name,
        data: typeof e.data === "string" ? e.data : JSON.stringify(e.data),
      })),
    });

    const bodyMd5 = md5(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const path = `/apps/${appId}/batch_events`;

    const toSign = [
      "POST",
      path,
      `auth_key=${key}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&nonce=${nonce}`,
    ].join("\n");

    const signature = await hmacSHA256(secret, toSign);

    const url =
      `https://api-${cluster}.pusher.com${path}` +
      `?auth_key=${key}&auth_timestamp=${timestamp}&auth_version=1.0` +
      `&body_md5=${bodyMd5}&nonce=${nonce}&auth_signature=${signature}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[Pusher] Trigger failed:", res.status, text);
    }
  },

  // Pusher channel auth (for private/presence channels)
  authorizeChannel(
    socketId: string,
    channel: string,
    presenceData?: { user_id: string; user_info: Record<string, unknown> }
  ): { auth: string; channel_data?: string } {
    // Note: This runs on Node.js runtime (pusher/auth route uses nodejs runtime)
    // So we use the sync version via the pusher package there instead
    // This method should not be called from Edge routes
    throw new Error("authorizeChannel must be called from Node.js runtime route");
  },
};

// ─── Standalone trigger helpers ───────────────────────────────────────────────
export async function triggerBatch(
  events: Array<{ channel: string; name: string; data: unknown }>
): Promise<void> {
  await pusherServer.triggerBatch(
    events.map((e) => ({
      channel: e.channel,
      name: e.name,
      data: typeof e.data === "string" ? e.data : JSON.stringify(e.data),
    }))
  );
}

// ─── Client-side Pusher singleton ────────────────────────────────────────────
// Import pusher-js only on client side to avoid Edge bundling issues
export function getPusherClient() {
  if (typeof window === "undefined") {
    throw new Error("getPusherClient() must be called client-side only");
  }
  // Dynamically imported to avoid SSR/Edge bundle issues
  const Pusher = require("pusher-js");
  return new Pusher(process.env.NEXT_PUBLIC_PUSHER_KEY!, {
    cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER!,
    authEndpoint: "/api/pusher/auth",
  });
  }
                                                                                            
