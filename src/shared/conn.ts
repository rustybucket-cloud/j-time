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

export type ConnReason = 'ok' | 'unconfigured' | 'rejected' | 'unreachable';

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
  /** Accelerator that toggles the palette. */
  hotkey: string;
}

export const DEFAULT_HOTKEY = 'Command+Shift+J';

export function defaultConfig(): JiraConfig {
  return {
    baseUrl: '',
    email: '',
    apiToken: '',
    activities: ['Meeting', 'Building', 'Testing', 'Review', 'Other'],
    roundMinutes: 5,
    boardId: null,
    mineOnly: true,
    hotkey: DEFAULT_HOTKEY,
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

/** One line explaining a failed connection, for the palette's footer. */
export function connMessage(conn: MyselfResult): string {
  switch (conn.reason) {
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
