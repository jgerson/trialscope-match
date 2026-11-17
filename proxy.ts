// Runs before every request: everything except the sign-in page (and the cron-called indexing sweep) needs a signed-in user. There is no sign-up page;
// accounts are created in Clerk's dashboard (the instance is invite-only).
// Pages redirect to the app's /sign-in; API routes get a 404 from auth.protect() (and a 401 from their own check).
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { touchVisit, VISIT_COOKIE } from "./lib/visit";

// /api/index-notes is called by Supabase's pg_cron, not a signed-in user; it checks its own shared secret.
const isPublic = createRouteMatcher(["/sign-in(.*)", "/api/index-notes"]);

// The production origins session tokens must come from, e.g. "https://match.trialscope.space". Unset (the default for a
// new deployment on a vercel.app address with Clerk's development keys), Clerk's default check applies.
const AUTHORIZED_ORIGINS = (process.env.CLERK_AUTHORIZED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);

export default clerkMiddleware(
  async (auth, req) => {
    if (!isPublic(req)) await auth.protect();
    // Start or extend the visit (lib/visit.ts): the id Langfuse groups this browser's traces by.
    return touchVisit(NextResponse.next(), req.cookies.get(VISIT_COOKIE)?.value);
  },
  // Without these, auth.protect() sends signed-out visitors to Clerk's hosted page instead of the app's own,
  // styled /sign-in. ClerkProvider in app/layout.tsx is given the same path.
  // authorizedParties: in production, accept session tokens only when they were issued for the app's own origin,
  // which Clerk recommends against subdomain attacks. Previews and local dev use other origins (and Clerk's
  // development keys), so they keep the default.
  {
    signInUrl: "/sign-in",
    authorizedParties: process.env.VERCEL_ENV === "production" && AUTHORIZED_ORIGINS.length ? AUTHORIZED_ORIGINS : undefined,
  },
);

export const config = {
  matcher: [
    // Skip Next.js internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
    // Always run for Clerk's frontend API proxy. With a production key on a vercel.app address, Clerk serves its
    // scripts from /__clerk on the app's own origin, and those .js paths would otherwise be skipped above (a 404, so
    // the sign-in form never loads).
    "/__clerk/(.*)",
  ],
};
