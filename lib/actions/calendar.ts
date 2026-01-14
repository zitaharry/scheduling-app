"use server";

import { auth } from "@clerk/nextjs/server";
import { writeClient } from "@/sanity/lib/writeClient";
import { client } from "@/sanity/lib/client";
import {
  USER_WITH_TOKENS_QUERY,
  type ConnectedAccountWithTokens,
} from "@/sanity/queries/users";
import { BOOKING_WITH_HOST_CALENDAR_QUERY } from "@/sanity/queries/bookings";
import {
  getCalendarClient,
  revokeGoogleToken,
  getEventAttendeeStatuses,
  fetchCalendarEvents,
  type AttendeeStatus,
} from "@/lib/google-calendar";

// ============================================================================
// Types
// ============================================================================

export type BusySlot = {
  start: string;
  end: string;
  accountEmail: string;
  title: string;
};

// ============================================================================
// Host Actions (Authenticated)
// ============================================================================

/**
 * Get the number of calendar accounts connected to the currently authenticated user.
 *
 * @returns The number of connected calendar accounts; `0` if the user is unauthenticated or has no connected accounts.
 */
export async function getUserConnectedAccountsCount(): Promise<number> {
  const { userId } = await auth();
  if (!userId) return 0;

  const user = await client.fetch(USER_WITH_TOKENS_QUERY, { clerkId: userId });
  return user?.connectedAccounts?.length ?? 0;
}

/**
 * Retrieve busy time slots across the user's connected Google Calendars between two dates.
 *
 * @returns An array of BusySlot objects where `start` and `end` are ISO 8601 strings, `accountEmail` is the calendar account's email, and `title` is the event title.
 */
export async function getGoogleBusyTimes(
  startDate: Date,
  endDate: Date,
): Promise<BusySlot[]> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await client.fetch(USER_WITH_TOKENS_QUERY, { clerkId: userId });
  if (!user?.connectedAccounts?.length) {
    return [];
  }

  const events = await fetchCalendarEvents(
    user.connectedAccounts,
    startDate,
    endDate,
  );

  return events.map((event) => ({
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    accountEmail: event.accountEmail,
    title: event.title,
  }));
}

/**
 * Disconnects a connected Google calendar account for the authenticated user.
 *
 * Revokes the account's Google access token (if present), removes the account
 * from the user's connected accounts in Sanity, and if the removed account
 * was the default, promotes the first remaining connected account to default.
 *
 * @param accountKey - The unique `_key` of the connected account to remove
 * @throws Error "Unauthorized" if the caller is not authenticated
 * @throws Error "User not found" if the authenticated user record cannot be found
 * @throws Error "Account not found" if no connected account matches `accountKey`
 */
export async function disconnectGoogleAccount(
  accountKey: string,
): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await client.fetch(USER_WITH_TOKENS_QUERY, { clerkId: userId });
  if (!user) throw new Error("User not found");

  // Find the account to disconnect
  const account = user.connectedAccounts?.find((a) => a._key === accountKey);
  if (!account) throw new Error("Account not found");

  // Revoke the token with Google
  if (account.accessToken) {
    await revokeGoogleToken(account.accessToken);
  }

  // Check if this was the default account
  const wasDefault = account.isDefault;
  const remainingAccounts = user.connectedAccounts?.filter(
    (a) => a._key !== accountKey,
  );

  // Remove the account from Sanity
  await writeClient
    .patch(user._id)
    .unset([`connectedAccounts[_key=="${accountKey}"]`])
    .commit();

  // If the removed account was the default and there are other accounts,
  // set the first remaining account as default
  if (wasDefault && remainingAccounts && remainingAccounts.length > 0) {
    const newDefaultKey = remainingAccounts[0]._key;
    await writeClient
      .patch(user._id)
      .set({
        [`connectedAccounts[_key=="${newDefaultKey}"].isDefault`]: true,
      })
      .commit();
  }
}

/**
 * Mark a connected calendar account as the default for new bookings.
 *
 * Updates the user's connected accounts so the account identified by `accountKey`
 * becomes the default; any other account previously marked default is cleared.
 *
 * @param accountKey - The Sanity `_key` of the connected account to set as default
 * @throws Error "Unauthorized" if the caller is not authenticated
 * @throws Error "User not found" if the authenticated user record cannot be loaded
 * @throws Error "Account not found" if no connected account matches `accountKey`
 */
export async function setDefaultCalendarAccount(
  accountKey: string,
): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await client.fetch(USER_WITH_TOKENS_QUERY, { clerkId: userId });
  if (!user) throw new Error("User not found");

  // Verify the account exists
  const account = user.connectedAccounts?.find((a) => a._key === accountKey);
  if (!account) throw new Error("Account not found");

  // Set all accounts to non-default, then set the target as default
  // We need to do this in two patches to avoid conflicts
  for (const acc of user.connectedAccounts ?? []) {
    if (acc._key !== accountKey && acc.isDefault) {
      await writeClient
        .patch(user._id)
        .set({
          [`connectedAccounts[_key=="${acc._key}"].isDefault`]: false,
        })
        .commit();
    }
  }

  // Set the target account as default
  await writeClient
    .patch(user._id)
    .set({
      [`connectedAccounts[_key=="${accountKey}"].isDefault`]: true,
    })
    .commit();
}

/**
 * Cancels a booking by removing its associated Google Calendar event (if present) and deleting the booking document from Sanity.
 *
 * @param bookingId - The Sanity booking document ID to cancel
 * @throws Error "Unauthorized" if the caller is not authenticated
 * @throws Error "Booking not found" if no booking exists with the given ID
 */
export async function cancelBooking(bookingId: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  // Get the booking with host info
  const booking = await client.fetch(BOOKING_WITH_HOST_CALENDAR_QUERY, {
    bookingId,
  });

  if (!booking) {
    throw new Error("Booking not found");
  }

  // Delete Google Calendar event if exists
  if (booking.googleEventId && booking.host?.connectedAccounts) {
    const account = booking.host.connectedAccounts;
    if (account.accessToken && account.refreshToken) {
      try {
        const calendar = await getCalendarClient(account);
        await calendar.events.delete({
          calendarId: "primary",
          eventId: booking.googleEventId,
          sendUpdates: "all", // Sends cancellation emails
        });
      } catch (error) {
        console.error("Failed to delete Google Calendar event:", error);
        // Continue anyway - delete booking from Sanity
      }
    }
  }

  // Delete booking from Sanity (Google Calendar is source of truth)
  await writeClient.delete(bookingId);
}

export type BookingStatuses = {
  guestStatus: AttendeeStatus;
  isCancelled: boolean;
};

/**
 * Delete the Google Calendar event (if present) and remove the corresponding booking document from Sanity.
 *
 * @param account - The connected Google account including access and refresh tokens
 * @param bookingId - The Sanity booking document ID to delete
 * @param googleEventId - The Google Calendar event ID to delete
 * @param eventStillExists - Whether the calendar event is believed to still exist; if `true` the function will attempt to delete it using `account` tokens
 */
async function cleanupCancelledBooking(
  account: ConnectedAccountWithTokens,
  bookingId: string,
  googleEventId: string,
  eventStillExists: boolean,
): Promise<void> {
  // Delete Google Calendar event if it still exists
  if (eventStillExists && account.accessToken && account.refreshToken) {
    try {
      const calendar = await getCalendarClient(account);
      await calendar.events.delete({
        calendarId: "primary",
        eventId: googleEventId,
        sendUpdates: "all",
      });
    } catch (error) {
      console.error("Failed to delete Google Calendar event:", error);
    }
  }

  // Delete booking from Sanity
  try {
    await writeClient.delete(bookingId);
  } catch (error) {
    console.error("Failed to delete booking from Sanity:", error);
  }
}

/**
 * Retrieve attendee statuses for multiple bookings from Google Calendar.
 *
 * For each booking that has an associated Google event, queries the host's calendar to determine
 * the guest's attendee status and whether the booking is cancelled. Cancelled bookings will be
 * cleaned up by removing the calendar event and deleting the booking record.
 *
 * @param bookings - Array of bookings to check. Each item must include:
 *   - `id`: booking document id
 *   - `googleEventId`: the Google Calendar event id, or `null` if none
 *   - `guestEmail`: the guest's email address as an attendee on the event
 * @returns A record mapping booking `id` to `BookingStatuses` for bookings that have a `googleEventId`.
 */
export async function getBookingAttendeeStatuses(
  bookings: Array<{
    id: string;
    googleEventId: string | null;
    guestEmail: string;
  }>,
): Promise<Record<string, BookingStatuses>> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await client.fetch(USER_WITH_TOKENS_QUERY, { clerkId: userId });
  if (!user?.connectedAccounts?.length) {
    return {};
  }

  // Find the default account (which is also the host's email)
  const account = user.connectedAccounts.find((a) => a.isDefault);
  if (!account?.accessToken || !account?.refreshToken) {
    return {};
  }

  const hostEmail = account.email;
  const statuses: Record<string, BookingStatuses> = {};

  // Fetch statuses in parallel
  const bookingsWithEvents = bookings.filter((b) => b.googleEventId);

  await Promise.all(
    bookingsWithEvents.map(async (booking) => {
      if (booking.googleEventId) {
        const { hostStatus, guestStatus } = await getEventAttendeeStatuses(
          account,
          booking.googleEventId,
          hostEmail,
          booking.guestEmail,
        );

        // Event is cancelled if deleted OR guest declined (no meeting will happen)
        const isCancelled =
          hostStatus === "declined" || guestStatus === "declined";
        statuses[booking.id] = { guestStatus, isCancelled };

        // Lazy delete: If cancelled, clean up Google Calendar event and Sanity booking
        if (isCancelled) {
          await cleanupCancelledBooking(
            account,
            booking.id,
            booking.googleEventId,
            hostStatus !== "declined",
          );
        }
      }
    }),
  );

  return statuses;
}

/**
 * Determine which bookings are still active by using the host's Google Calendar as the source of truth.
 *
 * If `hostAccount` lacks valid tokens, all booking IDs are treated as active. For bookings with a `googleEventId`,
 * the function checks attendee statuses in Google Calendar, performs lazy cleanup for cancelled events, and returns
 * the set of booking IDs that are not cancelled.
 *
 * @param hostAccount - The host's connected Google account and tokens; may be `null`.
 * @param bookings - Array of bookings to verify; each item must include `id`, `googleEventId`, and `guestEmail`.
 * @returns A set containing the IDs of bookings that are considered active (not cancelled).
 */
export async function getActivebookingIds(
  hostAccount: {
    accessToken: string | null;
    refreshToken: string | null;
    expiryDate?: number | null;
    _key: string;
    email: string;
  } | null,
  bookings: Array<{
    id: string;
    googleEventId: string | null;
    guestEmail: string;
  }>,
): Promise<Set<string>> {
  const activeIds = new Set<string>();

  // If no host account with valid tokens, assume all bookings are active (can't verify)
  if (!hostAccount?.accessToken || !hostAccount?.refreshToken) {
    for (const b of bookings) {
      activeIds.add(b.id);
    }
    return activeIds;
  }

  const accessToken = hostAccount.accessToken;
  const refreshToken = hostAccount.refreshToken;

  // Check each booking's status in Google Calendar
  await Promise.all(
    bookings.map(async (booking) => {
      if (!booking.googleEventId) {
        // No Google event - assume active
        activeIds.add(booking.id);
        return;
      }

      try {
        const account = {
          _key: hostAccount._key,
          accessToken,
          refreshToken,
          expiryDate: hostAccount.expiryDate ?? null,
          email: hostAccount.email,
          accountId: "",
          isDefault: true,
        };

        const { hostStatus, guestStatus } = await getEventAttendeeStatuses(
          account,
          booking.googleEventId,
          hostAccount.email,
          booking.guestEmail,
        );

        const isCancelled =
          hostStatus === "declined" || guestStatus === "declined";

        // Lazy delete: If cancelled, clean up Google Calendar event and Sanity booking
        if (isCancelled) {
          await cleanupCancelledBooking(
            account,
            booking.id,
            booking.googleEventId,
            hostStatus !== "declined",
          );
        } else {
          // Only add to active if not cancelled
          activeIds.add(booking.id);
        }
      } catch (error) {
        console.error(`Failed to check booking ${booking.id}:`, error);
        // On error, assume active to avoid blocking valid slots
        activeIds.add(booking.id);
      }
    }),
  );

  return activeIds;
}