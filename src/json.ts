/**
 * Reading JSON that came off a disk, from an editor or from another program.
 *
 * All of it has to survive a leading byte order mark. `JSON.parse` rejects one outright
 * — RFC 8259 §8.1 does not allow a BOM in the text, though it explicitly permits an
 * implementation to ignore one — and Node's `readFileSync(path, 'utf8')` hands it
 * straight through. On Windows that combination is not an edge case:
 *
 *   - Notepad's "UTF-8 with BOM" is one entry away from the default in Save As, and
 *     Notepad is what a new user opens config.json in.
 *   - PowerShell's `Out-File -Encoding utf8` writes a BOM in Windows PowerShell 5.1,
 *     which is what ships with Windows; so does `>` redirection.
 *
 * The failure it produced was `not valid JSON — Unexpected token 'ï»¿'`, which tells a
 * user nothing about what to change. The sampler already stripped a BOM off PowerShell
 * output for the same reason, so this is one rule for the whole project rather than a
 * new exception: every JSON that is read rather than constructed goes through here.
 *
 * Only the UTF-8 BOM. A file actually saved as UTF-16 is already mangled by the time it
 * has been decoded as UTF-8, and nothing at this level can put it back together.
 */

/** U+FEFF, and only at the very start — anywhere else it is legitimate content. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * `JSON.parse`, tolerant of a leading BOM.
 *
 * Throws exactly what `JSON.parse` throws, so callers keep whatever they already do
 * about a genuinely broken file — the config reader tells a SyntaxError apart from an
 * I/O error, the plan usage reader degrades to null, the docs generator refuses to run.
 */
export function parseJson(text: string): unknown {
  return JSON.parse(stripBom(text));
}
