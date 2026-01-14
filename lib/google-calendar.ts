import { google } from "googleapis";
import { writeClient } from "@/sanity/lib/writeClient";
import { client } from "@/sanity/lib/client";
import {
  USER_ID_BY_ACCOUNT_KEY_QUERY,
  type ConnectedAccountWithTokens,
} from "@/sanity/queries/users";

/**
 * Creates a Google OAuth2 client configured with client ID, client secret, and redirect URI from environment variables.
 *
 * @returns A configured `google.auth.OAuth2` client.
 */
export function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

/**
 * Builds a Google OAuth2 authorization URL for initiating account connection.
 *
 * @param state - Opaque value included in the authorization request and returned to the redirect URI for CSRF/state verification
 * @returns The authorization URL that a user should visit to grant access and obtain an authorization code
 */
export function getGoogleAuthUrl(state: string) {
  const oauth2Client = createOAuth2Client();

  const scopes = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ];

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "select_account consent", // Force account picker and consent
    state,
  });
}

/**
 * Exchanges a Google OAuth2 authorization code for OAuth2 tokens.
 *
 * @param code - The authorization code received from Google's OAuth consent flow
 * @returns An object containing OAuth2 tokens (e.g., `access_token`, `refresh_token`, `expiry_date`, `scope`)
 */
export async function exchangeCodeForTokens(code: string) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

/**
 * Fetches the authenticated Google user's id, email, and display name using an access token.
 *
 * @param accessToken - A valid Google OAuth2 access token for the user
 * @returns An object containing `id`, `email`, and `name` (may be undefined if not provided by Google)
 * @throws If the Google userinfo response does not include an `id` or `email`
 */
export async function getGoogleUserInfo(accessToken: string) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });

  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();

  if (!data.id || !data.email) {
    throw new Error("Failed to get user info from Google");
  }

  return {
    id: data.id,
    email: data.email,
    name: data.name,
  };
}

/**
 * Prepares a Google Calendar client authenticated for the given connected account.
 *
 * If the account's access token is expiring within 60 seconds, attempts to refresh it and persists new tokens to storage; on refresh failure or if refreshed credentials are invalid, throws an error indicating reconnection is required.
 *
 * @param account - Connected account record containing `accessToken`, `refreshToken`, `expiryDate`, and `_key` used to persist updated tokens
 * @returns A Google Calendar API client configured with the account's OAuth2 credentials
 * @throws Error if token refresh fails or refreshed credentials are missing required fields
 */
export async function getCalendarClient(account: ConnectedAccountWithTokens) {
  const oauth2Client = createOAuth2Client();

  oauth2Client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.expiryDate,
  });

  // Check if token needs refresh
  if (account.expiryDate && Date.now() >= account.expiryDate - 60000) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();

      if (!credentials.access_token || !credentials.expiry_date) {
        throw new Error("Invalid credentials received from refresh");
      }

      // Update tokens in Sanity
      await updateAccountTokens(account._key, {
        accessToken: credentials.access_token,
        expiryDate: credentials.expiry_date,
      });

      oauth2Client.setCredentials(credentials);
    } catch (error) {
      console.error("Failed to refresh token:", error);
      throw new Error("Token refresh failed. Please reconnect your account.");
    }
  }

  return google.calendar({ version: "v3", auth: oauth2Client });
}

/**
 * Persist refreshed access token and expiry for a connected account in Sanity.
 *
 * Finds the user document that contains the connected account identified by `accountKey`
 * and updates that account's `accessToken` and `expiryDate` fields with values from `tokens`.
 *
 * @param accountKey - The connected account `_key` used to locate the account within a user document
 * @param tokens - Object containing the new `accessToken` and numeric `expiryDate` (milliseconds since epoch)
 */
async function updateAccountTokens(
  accountKey: string,
  tokens: { accessToken: string; expiryDate: number },
) {
  // Find the user with this account and update the tokens
  const user = await client.fetch(USER_ID_BY_ACCOUNT_KEY_QUERY, { accountKey });

  if (user) {
    await writeClient
      .patch(user._id)
      .set({
        [`connectedAccounts[_key=="${accountKey}"].accessToken`]:
          tokens.accessToken,
        [`connectedAccounts[_key=="${accountKey}"].expiryDate`]:
          tokens.expiryDate,
      })
      .commit();
  }
}

// ============================================================================
// Shared Google Calendar Functions
// ============================================================================

/**
 * Represents a single event from Google Calendar.
 * Named to distinguish from UI CalendarEvent in components/calendar/types.ts
 */
export type GoogleCalendarEvent = {
  start: Date;
  end: Date;
  title: string;
  accountEmail: string;
};

/**
 * Aggregate date-time calendar events from multiple connected Google accounts within a date range.
 *
 * Skips accounts that lack access or refresh tokens and excludes all-day events (events that only have `date` fields).
 *
 * @param accounts - Connected Google accounts (must include tokens and an `email` field); accounts missing tokens are ignored.
 * @param startDate - Start of the query range
 * @param endDate - End of the query range
 * @returns An array of `GoogleCalendarEvent` objects for events that fall within the specified date range, each annotated with the originating account's email
 */
export async function fetchCalendarEvents(
  accounts: ConnectedAccountWithTokens[],
  startDate: Date,
  endDate: Date,
): Promise<GoogleCalendarEvent[]> {
  const events: GoogleCalendarEvent[] = [];

  for (const account of accounts) {
    if (!account.accessToken || !account.refreshToken) continue;

    try {
      const calendar = await getCalendarClient(account);
      const { data } = await calendar.events.list({
        calendarId: "primary",
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      for (const event of data.items ?? []) {
        // Skip all-day events (they have date instead of dateTime)
        if (!event.start?.dateTime || !event.end?.dateTime) continue;
        events.push({
          start: new Date(event.start.dateTime),
          end: new Date(event.end.dateTime),
          title: event.summary ?? "Busy",
          accountEmail: account.email,
        });
      }
    } catch (error) {
      console.error(`Failed to fetch events for ${account.email}:`, error);
    }
  }

  return events;
}

/**
 * Revokes a Google OAuth2 access token so it can no longer be used.
 *
 * @param accessToken - The OAuth2 access token to revoke
 */
export async function revokeGoogleToken(accessToken: string) {
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, {
      method: "POST",
    });
  } catch (error) {
    console.error("Failed to revoke token:", error);
    // Continue anyway - the token will expire eventually
  }
}

// Attendee response status type
export type AttendeeStatus =
  | "accepted"
  | "declined"
  | "tentative"
  | "needsAction"
  | "unknown";

/**
 * Retrieves the response status of a guest attendee for a Google Calendar event.
 *
 * @param account - The connected Google account (must include valid access/refresh tokens)
 * @param eventId - The Google Calendar event ID to inspect
 * @param guestEmail - The guest's email address to match (case-insensitive)
 * @returns The attendee's `AttendeeStatus` (`accepted`, `declined`, `tentative`, `needsAction`) or `unknown` if the attendee or status is missing or an error occurs
 */
export async function getEventAttendeeStatus(
  account: ConnectedAccountWithTokens,
  eventId: string,
  guestEmail: string,
): Promise<AttendeeStatus> {
  try {
    const calendar = await getCalendarClient(account);
    const response = await calendar.events.get({
      calendarId: "primary",
      eventId,
    });

    const attendee = response.data.attendees?.find(
      (a) => a.email?.toLowerCase() === guestEmail.toLowerCase(),
    );

    if (!attendee?.responseStatus) {
      return "unknown";
    }

    return attendee.responseStatus as AttendeeStatus;
  } catch (error) {
    console.error("Failed to get event attendee status:", error);
    return "unknown";
  }
}

// Get guest attendee status from Google Calendar event
/**
 * Determines host and guest attendee statuses for a Google Calendar event.
 *
 * If the event status is "cancelled" or the event is missing/deleted (HTTP 404/410), both host and guest are reported as `declined`. If the event exists, the host is reported as `accepted` (host is the organizer) and the guest status is taken from the event attendee `responseStatus` or `needsAction` if absent. On other errors, returns host `accepted` and guest `unknown`.
 *
 * @returns An object with `hostStatus` and `guestStatus` set to one of `accepted`, `declined`, `tentative`, `needsAction`, or `unknown`.
export async function getEventAttendeeStatuses(
  account: ConnectedAccountWithTokens,
  eventId: string,
  _hostEmail: string,
  guestEmail: string,
): Promise<{ hostStatus: AttendeeStatus; guestStatus: AttendeeStatus }> {
  try {
    const calendar = await getCalendarClient(account);
    const response = await calendar.events.get({
      calendarId: "primary",
      eventId,
    });

    // Check if event was cancelled in Google Calendar
    if (response.data.status === "cancelled") {
      return { hostStatus: "declined", guestStatus: "declined" };
    }

    // Event exists and is not cancelled - get guest status
    const guestAttendee = response.data.attendees?.find(
      (a) => a.email?.toLowerCase() === guestEmail.toLowerCase(),
    );

    return {
      // Host is the organizer, so if event exists, they accepted it
      hostStatus: "accepted",
      guestStatus:
        (guestAttendee?.responseStatus as AttendeeStatus) || "needsAction",
    };
  } catch (error: unknown) {
    // If event was deleted (404/410), treat as cancelled
    // Google API returns error code in different formats
    const gaxiosError = error as {
      code?: number;
      response?: { status?: number };
    };
    const errorCode = gaxiosError.code ?? gaxiosError.response?.status;
    if (errorCode === 404 || errorCode === 410) {
      return { hostStatus: "declined", guestStatus: "declined" };
    }
    console.error("Failed to get event attendee statuses:", error);
    // On error, assume event still exists but status unknown
    return { hostStatus: "accepted", guestStatus: "unknown" };
  }
}