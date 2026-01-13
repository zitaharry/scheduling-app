import { auth, clerkClient } from "@clerk/nextjs/server";
import { client } from "@/sanity/lib/client";
import { startOfMonth, endOfMonth } from "date-fns";

export type PlanType = "free" | "starter" | "pro";

export const PLAN_LIMITS = {
  free: {
    maxConnectedCalendars: 1,
    maxBookingsPerMonth: 2,
  },
  starter: {
    maxConnectedCalendars: 3,
    maxBookingsPerMonth: 10,
  },
  pro: {
    maxConnectedCalendars: Infinity,
    maxBookingsPerMonth: Infinity,
  },
} as const;

/**
 * Determine the current user's subscription plan from Clerk authentication.
 *
 * @returns `pro` if the user has an active "pro" plan, `starter` if the user has an active "starter" plan, `free` otherwise.
 */
export async function getUserPlan(): Promise<PlanType> {
  const { has } = await auth();

  if (has({ plan: "pro" })) return "pro";
  if (has({ plan: "starter" })) return "starter";
  return "free";
}

/**
 * Retrieve the current user's subscription plan and its associated limits.
 *
 * @returns An object with `maxConnectedCalendars`, `maxBookingsPerMonth`, and `plan` indicating the current plan and its limits.
 */
export async function getUserPlanLimits() {
  const plan = await getUserPlan();
  return { ...PLAN_LIMITS[plan], plan };
}

/**
 * Determines whether the current user may add another connected calendar.
 *
 * @param currentCount - Number of calendars the user currently has connected
 * @returns `true` if `currentCount` is less than the user's plan limit for connected calendars, `false` otherwise.
 */
export async function canConnectMoreCalendars(
  currentCount: number,
): Promise<boolean> {
  const limits = await getUserPlanLimits();
  return currentCount < limits.maxConnectedCalendars;
}

// Query to get host's clerkId by their public slug
const HOST_CLERK_ID_BY_SLUG_QUERY = `*[
  _type == "user"
  && slug.current == $hostSlug
][0].clerkId`;

// Query to count bookings for a host in a date range
const COUNT_HOST_BOOKINGS_QUERY = `count(*[
  _type == "booking"
  && host->slug.current == $hostSlug
  && startTime >= $monthStart
  && startTime < $monthEnd
])`;

/**
 * Determine a host's plan from their Clerk user metadata.
 *
 * Checks the user's public metadata for a `plan` field and returns `"pro"`, `"starter"`, or `"free"`. If the plan is not set or the Clerk lookup fails, `"free"` is returned.
 *
 * @param hostClerkId - The Clerk user ID of the host
 * @returns The host's plan: `"pro"`, `"starter"`, or `"free"`
 */
export async function getHostPlan(hostClerkId: string): Promise<PlanType> {
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(hostClerkId);

    // Check if user has an active subscription
    // Clerk Billing stores subscription info - check publicMetadata or subscription
    const metadata = user.publicMetadata as { plan?: string } | undefined;
    if (metadata?.plan === "pro") return "pro";
    if (metadata?.plan === "starter") return "starter";

    return "free";
  } catch (error) {
    console.error("Failed to fetch host plan from Clerk:", error);
    return "free";
  }
}

export type BookingQuotaStatus = {
  used: number;
  limit: number;
  remaining: number;
  isExceeded: boolean;
  plan: PlanType;
};

/**
 * Determine a host's monthly booking quota usage by their public slug.
 *
 * @param hostSlug - The host's public slug as shown in URLs
 * @returns An object with `used` (bookings in the current month), `limit` (maximum bookings allowed for the host's plan), `remaining` (bookings left this month, minimum 0), `isExceeded` (`true` if `used` is greater than or equal to `limit`), and `plan` (the host's plan)
 */
export async function getHostBookingQuotaStatus(
  hostSlug: string,
): Promise<BookingQuotaStatus> {
  // Get the host's clerkId from Sanity
  const hostClerkId = await client.fetch<string | null>(
    HOST_CLERK_ID_BY_SLUG_QUERY,
    { hostSlug },
  );

  if (!hostClerkId) {
    // Host not found, return exceeded to block booking
    return {
      used: 0,
      limit: 0,
      remaining: 0,
      isExceeded: true,
      plan: "free",
    };
  }

  // Get the host's plan via Clerk Backend API
  const plan = await getHostPlan(hostClerkId);
  const limit = PLAN_LIMITS[plan].maxBookingsPerMonth;

  // Count bookings this month
  const now = new Date();
  const monthStart = startOfMonth(now).toISOString();
  const monthEnd = endOfMonth(now).toISOString();

  const used = await client.fetch<number>(COUNT_HOST_BOOKINGS_QUERY, {
    hostSlug,
    monthStart,
    monthEnd,
  });

  const remaining = Math.max(0, limit - used);
  const isExceeded = used >= limit;

  return { used, limit, remaining, isExceeded, plan };
}