import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getGoogleAuthUrl } from "@/lib/google-calendar";

/**
 * Initiates Google OAuth for the current user by redirecting the client to Google's authorization URL.
 *
 * If the request is unauthenticated, redirects to "/". For authenticated requests, constructs a base64-encoded
 * state payload containing the current user's ID and a timestamp (used for CSRF protection), obtains the
 * Google authorization URL with that state, and redirects the client to it.
 */
export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    redirect("/");
  }

  // Create state parameter for CSRF protection
  // Security: Clerk auth on callback verifies userId matches authenticated user
  const state = Buffer.from(
    JSON.stringify({
      userId,
      timestamp: Date.now(),
    }),
  ).toString("base64");

  const authUrl = getGoogleAuthUrl(state);

  redirect(authUrl);
}