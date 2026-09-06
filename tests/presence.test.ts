import { describe, expect, it } from 'vitest';

import {
  LARGE_IMAGE_KEY,
  MAX_FIELD_LENGTH,
  ROTATION_INTERVAL_MS,
  SMALL_IMAGE_BUSY,
  SMALL_IMAGE_IDLE,
  buildActivity,
  fillTemplate,
  payloadFingerprint,
  rotationIndex,
  rotationItems,
  statusText,
  truncate,
} from '../src/discord/presence.js';
import type { PresenceInputs } from '../src/discord/presence.js';
import { parseConfig } from '../src/config.js';
import type { Config } from '../src/config.js';

const VALID_CLIENT_ID = '1234567890123456789';

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  const result = parseConfig({ clientId: VALID_CLIENT_ID, ...overrides });
  if (!result.ok) throw new Error('bad test config: ' + result.problems.join('; '));
  return result.config;
}

function makeInputs(overrides: Partial<PresenceInputs> = {}): PresenceInputs {
  return {
    state: 'IDLE',
    toolName: null,
    appVersion: '1.46388.4.0',
    mcpServerCount: 22,
    planUsage: { shortWindowPercent: 55, longWindowPercent: 22 },
    startTime: new Date('2026-09-06T08:00:00Z'),
    ...overrides,
  };
}

describe('fillTemplate', () => {
  it('substitutes placeholders', () => {
    expect(fillTemplate('{app} — {status}', { app: 'Claude Desktop', status: 'Idle' })).toBe(
      'Claude Desktop — Idle'
    );
  });

  it('substitutes numbers', () => {
    expect(fillTemplate('MCP: {count} servers', { count: 22 })).toBe('MCP: 22 servers');
  });

  it('renders a known-but-null value as empty, not as the literal placeholder', () => {
    expect(fillTemplate('Version {version}', { version: null })).toBe('Version ');
  });

  it('leaves an unknown placeholder alone, so a config typo is visible', () => {
    expect(fillTemplate('Hello {nope}', { app: 'x' })).toBe('Hello {nope}');
  });

  it('handles a template with no placeholders', () => {
    expect(fillTemplate('Idle', {})).toBe('Idle');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short')).toBe('short');
  });

  it('cuts to the Discord limit with an ellipsis, not a hard chop', () => {
    const long = 'a'.repeat(300);
    const result = truncate(long);

    expect(result).toHaveLength(MAX_FIELD_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });

  it('keeps exactly 128 characters untouched', () => {
    const exact = 'b'.repeat(MAX_FIELD_LENGTH);
    expect(truncate(exact)).toBe(exact);
  });
});

describe('statusText', () => {
  const config = makeConfig();

  it('maps each state to its configured string', () => {
    expect(statusText('BUSY', null, config.text, config.show)).toBe('Working…');
    expect(statusText('ACTIVE', null, config.text, config.show)).toBe('Active chat');
    expect(statusText('IDLE', null, config.text, config.show)).toBe('Idle');
  });

  it('puts the tool name in for TOOL', () => {
    expect(statusText('TOOL', 'Bash', config.text, config.show)).toBe('Tool: Bash');
  });

  it('falls back to the busy text when tool names are switched off', () => {
    const noTools = makeConfig({ show: { toolNames: false } });
    expect(statusText('TOOL', 'Bash', noTools.text, noTools.show)).toBe('Working…');
  });

  it('uses the translation from the config', () => {
    const czech = makeConfig({ text: { statusBusy: 'Pracuje…' } });
    expect(statusText('BUSY', null, czech.text, czech.show)).toBe('Pracuje…');
  });
});

describe('rotationItems', () => {
  it('includes both usage windows, the version and the server count', () => {
    const items = rotationItems(makeInputs(), makeConfig());

    expect(items).toEqual([
      'Usage 5h: 55 %',
      'Usage 7d: 22 %',
      'Version 1.46388.4.0',
      'MCP: 22 servers',
    ]);
  });

  it('honours every show switch', () => {
    const config = makeConfig({
      show: { planUsage: false, appVersion: false, mcpServerCount: true },
    });
    expect(rotationItems(makeInputs(), config)).toEqual(['MCP: 22 servers']);
  });

  it('skips values that are not known yet', () => {
    const items = rotationItems(
      makeInputs({ appVersion: null, mcpServerCount: null, planUsage: null }),
      makeConfig()
    );
    expect(items).toEqual([]);
  });
});

describe('rotationIndex', () => {
  it('advances once per rotation interval', () => {
    expect(rotationIndex(4, 0)).toBe(0);
    expect(rotationIndex(4, ROTATION_INTERVAL_MS - 1)).toBe(0);
    expect(rotationIndex(4, ROTATION_INTERVAL_MS)).toBe(1);
    expect(rotationIndex(4, ROTATION_INTERVAL_MS * 5)).toBe(1);
  });

  it('does not divide by zero when there is nothing to show', () => {
    expect(rotationIndex(0, 12345)).toBe(0);
  });
});

describe('buildActivity', () => {
  const config = makeConfig();

  it('returns null for OFFLINE — the caller clears the activity', () => {
    expect(buildActivity(makeInputs({ state: 'OFFLINE' }), config, 0)).toBe(null);
  });

  it('carries the real app name on the first line', () => {
    // The Discord app is registered as C.L.A.U.D.E, because Discord rejects "Claude".
    // Without this, the profile shows an unrecognisable acronym and nothing else.
    const payload = buildActivity(makeInputs({ state: 'BUSY' }), config, 0);

    expect(payload?.details).toBe('Claude Desktop — Working…');
    expect(payload?.details).toContain('Claude Desktop');
  });

  it('uses the asset keys uploaded in the Developer Portal', () => {
    const busy = buildActivity(makeInputs({ state: 'BUSY' }), config, 0);
    const idle = buildActivity(makeInputs({ state: 'IDLE' }), config, 0);

    expect(busy?.largeImageKey).toBe(LARGE_IMAGE_KEY);
    expect(busy?.largeImageKey).toBe('claude_logo');
    expect(busy?.smallImageKey).toBe(SMALL_IMAGE_BUSY);
    expect(idle?.smallImageKey).toBe(SMALL_IMAGE_IDLE);
  });

  it('uses the busy icon for TOOL as well', () => {
    const payload = buildActivity(makeInputs({ state: 'TOOL', toolName: 'Bash' }), config, 0);

    expect(payload?.smallImageKey).toBe(SMALL_IMAGE_BUSY);
    expect(payload?.details).toBe('Claude Desktop — Tool: Bash');
  });

  it('rotates the second line', () => {
    const inputs = makeInputs();
    const first = buildActivity(inputs, config, 0);
    const second = buildActivity(inputs, config, ROTATION_INTERVAL_MS);

    expect(first?.state).toBe('Usage 5h: 55 %');
    expect(second?.state).toBe('Usage 7d: 22 %');
  });

  it('leaves the second line empty when there is nothing to rotate', () => {
    const inputs = makeInputs({ appVersion: null, mcpServerCount: null, planUsage: null });
    expect(buildActivity(inputs, config, 0)?.state).toBeUndefined();
  });

  it('sets the elapsed timestamp only when enabled', () => {
    const on = buildActivity(makeInputs(), config, 0);
    const off = buildActivity(makeInputs(), makeConfig({ show: { elapsedTime: false } }), 0);

    expect(on?.startTimestamp?.toISOString()).toBe('2026-09-06T08:00:00.000Z');
    expect(off?.startTimestamp).toBeUndefined();
  });

  it('drops the version from the icon tooltip when it is unknown', () => {
    const known = buildActivity(makeInputs(), config, 0);
    const unknown = buildActivity(makeInputs({ appVersion: null }), config, 0);

    expect(known?.largeImageText).toBe('Claude Desktop 1.46388.4.0');
    // Not "Claude Desktop {version}" and not a trailing space.
    expect(unknown?.largeImageText).toBe('Claude Desktop');
  });

  it('truncates fields that the user made too long', () => {
    const shouty = makeConfig({
      text: { statusIdle: 'x'.repeat(400), appVersion: 'v'.repeat(400) },
    });
    const payload = buildActivity(makeInputs(), shouty, 0);

    expect(payload?.details.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
    expect((payload?.state ?? '').length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
    expect(payload?.details.endsWith('…')).toBe(true);
  });

  it('omits buttons unless the config asks for them', () => {
    expect(buildActivity(makeInputs(), config, 0)?.buttons).toBeUndefined();

    const withButton = makeConfig({
      buttons: [{ label: 'GitHub', url: 'https://github.com/example/repo' }],
    });
    expect(buildActivity(makeInputs(), withButton, 0)?.buttons).toEqual([
      { label: 'GitHub', url: 'https://github.com/example/repo' },
    ]);
  });

  it('sends nothing that could identify the user (SPEC §5)', () => {
    const serialised = JSON.stringify(buildActivity(makeInputs(), config, 0));

    expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i); // no org UUID
    expect(serialised).not.toContain('C:\\');
    expect(serialised).not.toContain('AppData');
  });
});

describe('payloadFingerprint', () => {
  const config = makeConfig();

  it('is identical for identical payloads', () => {
    const a = buildActivity(makeInputs(), config, 0);
    const b = buildActivity(makeInputs(), config, 0);

    expect(payloadFingerprint(a)).toBe(payloadFingerprint(b));
  });

  it('changes when the state changes', () => {
    const idle = buildActivity(makeInputs({ state: 'IDLE' }), config, 0);
    const busy = buildActivity(makeInputs({ state: 'BUSY' }), config, 0);

    expect(payloadFingerprint(idle)).not.toBe(payloadFingerprint(busy));
  });

  it('changes when the rotation moves on', () => {
    const first = buildActivity(makeInputs(), config, 0);
    const second = buildActivity(makeInputs(), config, ROTATION_INTERVAL_MS);

    expect(payloadFingerprint(first)).not.toBe(payloadFingerprint(second));
  });

  it('compares timestamps by value, not by object identity', () => {
    const a = buildActivity(makeInputs({ startTime: new Date(1000) }), config, 0);
    const b = buildActivity(makeInputs({ startTime: new Date(1000) }), config, 0);

    expect(payloadFingerprint(a)).toBe(payloadFingerprint(b));
  });

  it('has a distinct value for "nothing to show"', () => {
    expect(payloadFingerprint(null)).toBe('null');
  });
});
