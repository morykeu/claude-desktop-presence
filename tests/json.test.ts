import { describe, expect, it } from 'vitest';

import { parseJson, stripBom } from '../src/json.js';

/**
 * The BOM rule for the whole project, in one place.
 *
 * `JSON.parse` rejects a leading byte order mark, and `readFileSync(path, 'utf8')` does
 * not remove one. On Windows that combination is routine rather than exotic: Notepad
 * offers "UTF-8 with BOM" one entry from the default, and Windows PowerShell 5.1 writes
 * a BOM from `Out-File -Encoding utf8` and from `>`. A config saved by either used to
 * fail with `Unexpected token 'ï»¿'`, which says nothing a user can act on.
 */

const BOM = '﻿';

describe('stripBom', () => {
  it('removes a byte order mark at the very start', () => {
    expect(stripBom(`${BOM}{"a":1}`)).toBe('{"a":1}');
  });

  it('leaves text without one untouched', () => {
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom('')).toBe('');
  });

  it('removes only one, so a doubled mark still fails loudly', () => {
    // Two marks means something upstream is wrong; quietly swallowing both would hide
    // it. The second is left to fail the parse.
    expect(stripBom(`${BOM}${BOM}{}`)).toBe(`${BOM}{}`);
  });

  it('leaves U+FEFF alone anywhere but the first character', () => {
    // Mid-string it is legitimate content, not an encoding artefact.
    const withMarkInside = `{"note":"a${BOM}b"}`;
    expect(stripBom(withMarkInside)).toBe(withMarkInside);
  });
});

describe('parseJson', () => {
  it('parses a document saved with a BOM', () => {
    expect(parseJson(`${BOM}{"clientId":"1234567890123456789"}`)).toEqual({
      clientId: '1234567890123456789',
    });
  });

  it('parses an ordinary document', () => {
    expect(parseJson('{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });

  it('throws what JSON.parse throws, so callers can still tell broken from unreadable', () => {
    // The config reader distinguishes a SyntaxError from an I/O error in its message,
    // and the docs generator refuses to run at all. Swallowing here would break both.
    expect(() => parseJson('{ "clientId": ')).toThrow(SyntaxError);
    expect(() => parseJson(`${BOM}{ "clientId": `)).toThrow(SyntaxError);
  });

  it('does not make a BOM-only document parse', () => {
    expect(() => parseJson(BOM)).toThrow(SyntaxError);
  });
});
