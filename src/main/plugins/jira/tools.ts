/**
 * The JIRA plugin's MCP tools.
 *
 * Separate from `index.ts` because they are a second audience, not a second
 * feature: every one of these calls the same function the palette's rows call,
 * and what is different is only that the caller cannot see the board. So the
 * writes are the plugin's existing actions, unchanged, and the reads are
 * `shared/report.ts` turning the snapshot into sentences.
 *
 * The names carry over from the app this grew out of — `start_timer`,
 * `file_time`, `finish_story` — because somebody's skill file already says them.
 * The shell prefixes each with `jira_`.
 */

import type { ActionResult } from '@shared/plugin';
import type { JiraIssue, JiraTransition, TimerState } from '@shared/types';
import type { JiraConfig } from '@shared/conn';
import { describeBoard, describeStory, describeTimer } from '@shared/report';
import { preferredDoneTransition } from '@shared/stages';
import { argStr, optionalArgStr, type McpTool } from '../../plugin';

/** Everything the tools need from the plugin, so this file holds no state. */
export interface ToolDeps {
  now(): number;
  state(): TimerState;
  config(): JiraConfig;
  /** The board as last fetched, Done column included. */
  issues(): JiraIssue[];
  transitions(key: string): Promise<JiraTransition[]>;
  start(key: string): Promise<ActionResult>;
  stop(activity?: string): Promise<ActionResult>;
  fileTime(key: string, activity: string): Promise<ActionResult>;
  finish(key: string, transitionId?: string): Promise<ActionResult>;
  transition(key: string, transitionId: string): Promise<ActionResult>;
  relabel(key: string, from: string, to: string): Promise<ActionResult>;
}

const KEY = { type: 'string', description: 'Issue key, e.g. PROJ-123.' };

/**
 * Hold the caller to the user's own activity labels.
 *
 * A worklog comment is what the user reads back at the end of the month, so a
 * model inventing "Coding" next to their "Building" quietly splits the same work
 * in two. Matching case-insensitively and returning the configured spelling is
 * the part that makes the check helpful rather than merely strict.
 */
function resolveActivity(config: JiraConfig, given: string): string {
  const labels = config.activities;
  if (labels.length === 0) return given;
  const match = labels.find((a) => a.toLowerCase() === given.toLowerCase());
  if (match) return match;
  throw new Error(`"${given}" is not one of the configured labels: ${labels.join(', ')}.`);
}

export function jiraTools(deps: ToolDeps): McpTool[] {
  return [
    {
      name: 'current_timer',
      readOnly: true,
      description:
        'What the clock is doing right now: the running story if any, how long the current ' +
        'chunk has been open, and how much tracked time is filed against JIRA versus still ' +
        'waiting. Also lists stopped time on other stories that nobody has filed yet. Start ' +
        'here before starting or stopping anything.',
      run: () => {
        const config = deps.config();
        const labels = config.activities.length
          ? config.activities.join(', ')
          : 'none configured yet';
        return [
          describeTimer(deps.state(), deps.now()),
          '',
          `Activity labels: ${labels}. The Done sweep rounds to ${config.roundMinutes} minutes; ` +
            'filing is exact.',
        ].join('\n');
      },
    },
    {
      name: 'list_stories',
      readOnly: true,
      description:
        "The board as its three columns — To Do, In Progress, Done — with this timer's " +
        'tracked time folded into each story, and which one is running. Use it to find the ' +
        'key for the work the user is describing.',
      run: () => describeBoard(deps.issues(), deps.state(), deps.now()),
    },
    {
      name: 'story_time',
      readOnly: true,
      description:
        'One story in detail: status, estimate, what JIRA has spent on it, and this app\'s ' +
        'tracked time broken down per activity. "Running" is the open chunk, which no label ' +
        'covers until it is stopped; "Untracked" is time already in JIRA that this app never ' +
        'measured.',
      input: { key: KEY },
      required: ['key'],
      run: (args) => {
        const key = argStr(args, 'key').toUpperCase();
        const issue = deps.issues().find((i) => i.key === key) ?? null;
        return describeStory(key, issue, deps.state(), deps.now());
      },
    },
    {
      name: 'start_timer',
      description:
        'Start the clock on a story, opening a new segment. Stops whatever was running first ' +
        '— only one story can be active. Local only: nothing is sent to JIRA and no status ' +
        'changes, so this is safe to call whenever the user says what they are working on.',
      input: { key: KEY },
      required: ['key'],
      run: (args) => deps.start(argStr(args, 'key').toUpperCase()),
    },
    {
      name: 'stop_timer',
      description:
        'Stop the clock, closing the open segment. Local only — the chunk is now stopped and ' +
        'unfiled, and nothing reaches JIRA until file_time. An activity here just pre-labels ' +
        'the chunk it closes.',
      input: {
        activity: {
          type: 'string',
          description: 'One of the configured activity labels, to label the chunk being closed.',
        },
      },
      run: (args) => {
        const given = optionalArgStr(args, 'activity');
        return deps.stop(given === undefined ? undefined : resolveActivity(deps.config(), given));
      },
    },
    {
      name: 'file_time',
      destructive: true,
      description:
        'WRITES TO JIRA. File every stopped, unfiled chunk on a story under one activity and ' +
        'post it as a worklog immediately, at its exact measured length. Stops the clock first ' +
        'if that story is running. Time is measured, never estimated — never call this to ' +
        'record a duration the clock did not actually run.',
      input: {
        key: KEY,
        activity: {
          type: 'string',
          description: 'One of the configured activity labels. Becomes the worklog comment.',
        },
      },
      required: ['key', 'activity'],
      run: (args) =>
        deps.fileTime(
          argStr(args, 'key').toUpperCase(),
          resolveActivity(deps.config(), argStr(args, 'activity')),
        ),
    },
    {
      name: 'relabel_time',
      description:
        'Move tracked time from one activity label to another — the fix for a chunk stopped ' +
        'without a label, or filed under the wrong one. Local display only: a worklog JIRA ' +
        'already has is never re-sent, so this does not change what was logged.',
      input: {
        key: KEY,
        from: { type: 'string', description: 'The label to move time off, e.g. Unlabelled.' },
        to: { type: 'string', description: 'The label to move it to.' },
      },
      required: ['key', 'from', 'to'],
      run: (args) =>
        deps.relabel(
          argStr(args, 'key').toUpperCase(),
          argStr(args, 'from'),
          resolveActivity(deps.config(), argStr(args, 'to')),
        ),
    },
    {
      name: 'list_transitions',
      readOnly: true,
      description:
        'The status transitions available on a story, each with the board column it lands in, ' +
        "plus which one means finished — JIRA's Done category also holds Cancelled, so the " +
        'right one cannot be guessed from the category alone.',
      input: { key: KEY },
      required: ['key'],
      run: async (args) => {
        const key = argStr(args, 'key').toUpperCase();
        const transitions = await deps.transitions(key);
        if (transitions.length === 0) return `${key} offers no transitions.`;
        const done = preferredDoneTransition(transitions);
        const lines = transitions.map(
          (t) =>
            `  ${t.id} — ${t.name} → ${t.to} (${t.toStage})` +
            (done && done.id === t.id ? '  ← the finishing one' : ''),
        );
        return [`Transitions on ${key}:`, ...lines].join('\n');
      },
    },
    {
      name: 'transition_story',
      destructive: true,
      description:
        'WRITES TO JIRA. Move a story to a new status without logging any time. Get the ' +
        'transition id from list_transitions.',
      input: {
        key: KEY,
        transition_id: { type: 'string', description: 'Transition id from list_transitions.' },
      },
      required: ['key', 'transition_id'],
      run: (args) =>
        deps.transition(argStr(args, 'key').toUpperCase(), argStr(args, 'transition_id')),
    },
    {
      name: 'finish_story',
      destructive: true,
      description:
        'WRITES TO JIRA. Finish a story: sweep whatever is still unfiled into one rounded ' +
        'worklog, then move the status if a transition id is given. Usually there is nothing ' +
        'left to sweep, because file_time sends time as it goes. Ask the user before calling ' +
        'this — it is the one action that both logs time and changes status.',
      input: {
        key: KEY,
        transition_id: {
          type: 'string',
          description:
            'Transition to make after sweeping. Omit to log the leftover and leave the status ' +
            'alone; get the id from list_transitions.',
        },
      },
      required: ['key'],
      run: (args) =>
        deps.finish(argStr(args, 'key').toUpperCase(), optionalArgStr(args, 'transition_id')),
    },
  ];
}
