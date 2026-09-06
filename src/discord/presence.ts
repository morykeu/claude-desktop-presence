/**
 * State -> Discord payload.
 *
 * The first line carries "Claude Desktop" on purpose. Discord rejects any application
 * name containing "claude", so the app is registered as C.L.A.U.D.E — that is what the
 * presence header shows, and nobody would recognise it. The real name has to be in
 * `details` or the profile is unreadable (SPEC §3).
 *
 * The asset keys have to match what is uploaded in the Discord Developer Portal:
 * `claude_logo` for the large icon, `busy` / `idle` for the small one. A key that is not
 * uploaded renders as nothing at all, with no error.
 *
 * No user-facing string is hardcoded here; they all come from config.text.
 */

import type { Config, ShowFlags, TextTemplates } from '../config.js';
import type { PresenceState } from '../state.js';

/** How long one item stays in the rotating second line. */
export const ROTATION_INTERVAL_MS = 20_000;

/** Discord truncates details and state at 128 characters. */
export const MAX_FIELD_LENGTH = 128;

/** Uploaded in the Developer Portal under exactly these keys. */
export const LARGE_IMAGE_KEY = 'claude_logo';
export const SMALL_IMAGE_BUSY = 'busy';
export const SMALL_IMAGE_IDLE = 'idle';

export interface ActivityButton {
  label: string;
  url: string;
}

/** What gets handed to setActivity. */
export interface ActivityPayload {
  details: string;
  state: string | undefined;
  startTimestamp: Date | undefined;
  largeImageKey: string;
  largeImageText: string | undefined;
  smallImageKey: string;
  smallImageText: string | undefined;
  buttons: ActivityButton[] | undefined;
}

/** Everything the payload is built from. No sensitive values (SPEC §5). */
export interface PresenceInputs {
  state: PresenceState;
  toolName: string | null;
  appVersion: string | null;
  mcpServerCount: number | null;
  planUsage: { shortWindowPercent: number; longWindowPercent: number } | null;
  startTime: Date | null;
}

/**
 * Substitutes {name} placeholders.
 *
 * A key present in `vars` with a null value becomes empty — that is how a missing app
 * version disappears instead of rendering as the literal "{version}". A placeholder
 * that is not in `vars` at all is left alone, so a typo in the user's config shows up
 * as itself rather than silently vanishing.
 */
export function fillTemplate(
  template: string,
  vars: Record<string, string | number | null>
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!(name in vars)) return match;
    const value = vars[name];
    return value === null || value === undefined ? '' : String(value);
  });
}

/**
 * Trims to Discord's limit with an ellipsis rather than a hard cut. The strings come
 * from the user's config, so they can be any length at all.
 */
export function truncate(text: string, max = MAX_FIELD_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

/** The status half of the first line. */
export function statusText(
  state: PresenceState,
  toolName: string | null,
  text: TextTemplates,
  show: ShowFlags
): string {
  switch (state) {
    case 'TOOL':
      // With tool names switched off, a tool call is just work.
      return show.toolNames && toolName !== null
        ? fillTemplate(text.statusTool, { tool: toolName })
        : text.statusBusy;
    case 'BUSY':
      return text.statusBusy;
    case 'ACTIVE':
      return text.statusActive;
    case 'IDLE':
    case 'OFFLINE':
    default:
      return text.statusIdle;
  }
}

/** The items the second line rotates through — only what the config allows. */
export function rotationItems(inputs: PresenceInputs, config: Config): string[] {
  const { show, text } = config;
  const items: string[] = [];

  if (show.planUsage && inputs.planUsage !== null) {
    items.push(
      fillTemplate(text.planUsageShortWindow, { percent: inputs.planUsage.shortWindowPercent }),
      fillTemplate(text.planUsageLongWindow, { percent: inputs.planUsage.longWindowPercent })
    );
  }
  if (show.appVersion && inputs.appVersion !== null) {
    items.push(fillTemplate(text.appVersion, { version: inputs.appVersion }));
  }
  if (show.mcpServerCount && inputs.mcpServerCount !== null) {
    items.push(fillTemplate(text.mcpServerCount, { count: inputs.mcpServerCount }));
  }
  return items.filter((item) => item.trim() !== '');
}

/**
 * Which rotation item is showing.
 *
 * Derived from the clock rather than from a counter, so it does not depend on how often
 * the loop ticks and does not jump when the set of items changes.
 */
export function rotationIndex(itemCount: number, now: number): number {
  if (itemCount <= 0) return 0;
  return Math.floor(now / ROTATION_INTERVAL_MS) % itemCount;
}

/** null means "show nothing" — the caller clears the activity. */
export function buildActivity(
  inputs: PresenceInputs,
  config: Config,
  now: number
): ActivityPayload | null {
  if (inputs.state === 'OFFLINE') return null;

  const { show, text } = config;
  const status = statusText(inputs.state, inputs.toolName, text, show);
  const details = fillTemplate(text.detailsFormat, { app: text.appName, status });

  const items = rotationItems(inputs, config);
  const secondLine = items[rotationIndex(items.length, now)];

  const largeImageText = fillTemplate(text.largeImageText, {
    app: text.appName,
    version: inputs.appVersion,
  }).trim();

  const busy = inputs.state === 'BUSY' || inputs.state === 'TOOL';

  return {
    details: truncate(details),
    state: secondLine === undefined ? undefined : truncate(secondLine),
    startTimestamp: show.elapsedTime && inputs.startTime !== null ? inputs.startTime : undefined,
    largeImageKey: LARGE_IMAGE_KEY,
    largeImageText: largeImageText === '' ? undefined : truncate(largeImageText),
    smallImageKey: busy ? SMALL_IMAGE_BUSY : SMALL_IMAGE_IDLE,
    smallImageText: truncate(status),
    buttons: config.buttons.length > 0 ? config.buttons.map((b) => ({ ...b })) : undefined,
  };
}

/** Stable key for the rate-limit gate: identical payloads must not be resent. */
export function payloadFingerprint(payload: ActivityPayload | null): string {
  if (payload === null) return 'null';
  return JSON.stringify({
    ...payload,
    startTimestamp: payload.startTimestamp?.getTime() ?? null,
  });
}
