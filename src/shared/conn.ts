/**
 * Connection-state classification, plus the shape of everything the app is
 * configured with.
 *
 * Pure and I/O-free so it can be unit-tested directly and imported from the
 * renderer as well as the main process.
 *
 * Ported from jira-timer, where credentials came from environment variables. A
 * packaged desktop app has no `.env.local` and no shell to inherit one from, so
 * the same three values are config *fields* here, edited in the Settings view and
 * written to ~/.j-time/config.json. `missingCreds` still exists for the same
 * reason it did there: a half-filled config should read as "not set up yet"
 * rather than as a credential rejection.
 */

/**
 * `checking` is the state before the first `getMyself` has answered. It exists
 * because the panel now opens on launch, in front of a snapshot whose connection
 * is simply not known yet — and every other reason is a *failure*, so borrowing
 * one of them told a configured user their credentials were bad for as long as
 * the round trip took, and bounced them to Settings on the way.
 */
export type ConnReason = 'checking' | 'ok' | 'unconfigured' | 'rejected' | 'unreachable';

/** The fields the app cannot talk to JIRA without, in the order we report them. */
export const CRED_FIELDS = ['baseUrl', 'email', 'apiToken'] as const;

export type CredField = (typeof CRED_FIELDS)[number];

export const CRED_LABELS: Record<CredField, string> = {
  baseUrl: 'JIRA URL',
  email: 'Account email',
  apiToken: 'API token',
};

/** Example values from the README — present in the file but not actually filled in. */
const PLACEHOLDERS = new Set([
  'paste-your-token-here',
  'https://your-org.atlassian.net',
  'you@example.com',
]);

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Activity labels offered when filing time. Empty turns the feature off. */
  activities: string[];
  /** Rounding increment for the Done sweep only. Filing is always exact. */
  roundMinutes: number;
  /** Board to show, or null for every board you have work in. */
  boardId: number | null;
  /** Restrict the board to issues assigned to you. */
  mineOnly: boolean;
}

export function defaultConfig(): JiraConfig {
  return {
    baseUrl: '',
    email: '',
    apiToken: '',
    activities: ['Meeting', 'Building', 'Testing', 'Review', 'Other'],
    roundMinutes: 5,
    boardId: null,
    mineOnly: true,
  };
}

/**
 * Which credential fields are effectively unset: absent, blank, or still holding
 * a placeholder. Filling in only some of them is the most common setup mistake,
 * and it should send you back to Settings rather than to a confusing 401.
 */
export function missingCreds(cfg: Partial<Record<CredField, string | undefined>>): CredField[] {
  return CRED_FIELDS.filter((f) => {
    const value = cfg[f]?.trim();
    return !value || PLACEHOLDERS.has(value);
  });
}

/** Map an HTTP status (0 for a thrown fetch) onto a connection reason. */
export function reasonForStatus(status: number): ConnReason {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'rejected';
  return 'unreachable';
}

/** What the main process reports about the JIRA connection. Never carries the token. */
export interface MyselfResult {
  ok: boolean;
  status: number;
  reason: ConnReason;
  /** Field NAMES that are unset. Never contains values. */
  missing: CredField[];
  /** Non-secret base URL, echoed back so the setup view can show what's known. */
  baseUrl: string | null;
  name?: string;
  email?: string;
  error?: string;
}

/**
 * The status dot's modifier class: green connected, red failed, and *neither*
 * while the check is still out — a bare `.dot` is the neutral one, so a pending
 * connection must not be painted with the failure colour.
 */
export function connDotClass(conn: MyselfResult): 'ok' | 'bad' | '' {
  if (conn.ok) return 'ok';
  return conn.reason === 'checking' ? '' : 'bad';
}

/** One line explaining a failed connection, for the palette's footer. */
export function connMessage(conn: MyselfResult): string {
  switch (conn.reason) {
    case 'checking':
      return 'Checking your JIRA connection…';
    case 'ok':
      return conn.name ? `Connected as ${conn.name}` : 'Connected';
    case 'unconfigured':
      return `Not set up — missing ${conn.missing.map((f) => CRED_LABELS[f]).join(', ')}`;
    case 'rejected':
      return 'JIRA rejected these credentials. Check the email and API token.';
    case 'unreachable':
      return conn.baseUrl ? `Can't reach ${conn.baseUrl}` : "Can't reach JIRA";
  }
}
