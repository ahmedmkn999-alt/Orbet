// middleware.ts (root of project)
// Clerk middleware - protects all /api routes except webhooks
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Public routes that don't require authentication
const isPublicRoute = createRouteMatcher([
  "/api/webhooks/(.*)", // Clerk + any future webhooks
  "/api/health",        // Uptime checks
]);

export default clerkMiddleware(async (auth, req) => {
  // Skip auth for public routes
  if (isPublicRoute(req)) {
    return NextResponse.next();
  }

  // Protect all other API routes
  const { userId } = await auth();

  if (!userId && req.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Apply to all API routes
    "/api/(.*)",
    // Skip Next.js internals
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
