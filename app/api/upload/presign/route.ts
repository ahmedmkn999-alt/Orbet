// app/api/upload/presign/route.ts
// Generates presigned URLs for direct client-to-R2 uploads
// Server never touches the file data - just signs the URL
import { NextRequest } from "next/server";
import { z } from "zod";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { withAuth, apiError, apiSuccess } from "@/middleware/auth";
import { uploadLimiter } from "@/lib/redis";

export const runtime = "edge";

// R2 is S3-compatible
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME!;
const CDN_URL = process.env.R2_CDN_URL!; // e.g. https://cdn.yourapp.com

// Allowed MIME types
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
]);

const presignSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().max(100),
  size: z.number().int().positive().max(100_000_000), // 100MB
});

// ─── POST /api/upload/presign ─────────────────────────────────────────────────
export const POST = withAuth(async (req, { auth }) => {
  // Rate limit uploads
  const { success, reset } = await uploadLimiter.limit(auth.userId);
  if (!success) return apiError.rateLimit(reset);

  let body: z.infer<typeof presignSchema>;
  try {
    body = presignSchema.parse(await req.json());
  } catch {
    return apiError.badRequest("Invalid payload");
  }

  // Validate MIME type
  if (!ALLOWED_MIMES.has(body.mimeType)) {
    return apiError.badRequest(`File type '${body.mimeType}' is not allowed`);
  }

  // Generate unique key with user prefix for organization
  const ext = body.filename.split(".").pop()?.toLowerCase() ?? "bin";
  const key = `uploads/${auth.userId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  // Generate presigned PUT URL (15 min expiry)
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: body.mimeType,
    ContentLength: body.size,
    // Metadata for tracing
    Metadata: {
      userId: auth.userId,
      originalFilename: encodeURIComponent(body.filename),
    },
  });

  const presignedUrl = await getSignedUrl(r2, command, {
    expiresIn: 900, // 15 minutes
  });

  // The public CDN URL the client should reference after upload
  const publicUrl = `${CDN_URL}/${key}`;

  return apiSuccess({
    uploadUrl: presignedUrl,  // PUT to this URL directly from client
    publicUrl,                // Use this URL in the message payload
    key,
    expiresIn: 900,
  });
});
