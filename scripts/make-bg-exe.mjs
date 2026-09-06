#!/usr/bin/env node
/**
 * Produces the windowless build by flipping one field in the PE header.
 *
 * pkg only emits console applications, so a Scheduled Task starting the .exe at logon
 * pops up a cmd window every time — unacceptable for something meant to sit in the
 * background. Switching the PE subsystem from CONSOLE (3) to WINDOWS (2) makes Windows
 * start it without allocating a console. It is a two-byte edit, needs no extra
 * dependency, and does not touch the code.
 *
 * Both binaries ship, because the change is not free:
 *   claude-desktop-presence.exe      console — --calibrate, --debug, anything interactive
 *   claude-desktop-presence-bg.exe   windowless — autostart; console output goes nowhere
 *
 * The alternatives were considered and rejected:
 *   - "Run whether user is logged on or not" hides the window but moves the task into
 *     session 0, where \\.\pipe\discord-ipc-0 does not exist. The presence would stop
 *     working entirely (SPEC §0).
 *   - A VBScript launcher: Microsoft has deprecated VBScript and is making it an
 *     optional feature in Windows 11.
 *
 * Layout: e_lfanew at 0x3C points at "PE\0\0"; the COFF header is 20 bytes; the
 * Subsystem field sits at offset 68 of the optional header, which is the same for PE32
 * and PE32+.
 *
 * Usage: node scripts/make-bg-exe.mjs <source.exe> <target.exe>
 */

import { copyFileSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import process from 'node:process';

export const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
export const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

const PE_SIGNATURE_OFFSET_AT = 0x3c;
const COFF_HEADER_SIZE = 20;
const SUBSYSTEM_OFFSET_IN_OPTIONAL_HEADER = 68;

/** Byte offset of the Subsystem field, or an Error describing why it is not a PE file. */
export function findSubsystemOffset(readAt) {
  if (readAt(0, 2).toString('latin1') !== 'MZ') {
    throw new Error('not a PE file: missing MZ signature');
  }

  const peOffset = readAt(PE_SIGNATURE_OFFSET_AT, 4).readUInt32LE(0);
  if (readAt(peOffset, 4).toString('latin1') !== 'PE\0\0') {
    throw new Error(`not a PE file: no PE signature at 0x${peOffset.toString(16)}`);
  }

  const magic = readAt(peOffset + 4 + COFF_HEADER_SIZE, 2).readUInt16LE(0);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`unexpected optional header magic 0x${magic.toString(16)}`);
  }

  return peOffset + 4 + COFF_HEADER_SIZE + SUBSYSTEM_OFFSET_IN_OPTIONAL_HEADER;
}

function run(source, target) {
  copyFileSync(source, target);

  const fd = openSync(target, 'r+');
  try {
    const readAt = (position, length) => {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, position);
      if (read !== length) throw new Error(`short read at ${position}`);
      return buffer;
    };

    const offset = findSubsystemOffset(readAt);
    const current = readAt(offset, 2).readUInt16LE(0);

    if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
      console.log(`make-bg-exe: ${target} is already windowless.`);
      return;
    }
    if (current !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
      throw new Error(`unexpected subsystem ${current}; refusing to patch`);
    }

    const patched = Buffer.alloc(2);
    patched.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, 0);
    writeSync(fd, patched, 0, 2, offset);

    // Read it back rather than trusting the write.
    const verify = readAt(offset, 2).readUInt16LE(0);
    if (verify !== IMAGE_SUBSYSTEM_WINDOWS_GUI) {
      throw new Error(`patch did not take: subsystem is still ${verify}`);
    }

    console.log(
      `make-bg-exe: ${target} subsystem CONSOLE -> WINDOWS ` +
        `(offset 0x${offset.toString(16)}); it will start without a console window.`
    );
  } finally {
    closeSync(fd);
  }
}

const [source, target] = process.argv.slice(2);
if (source === undefined || target === undefined) {
  console.error('Usage: node scripts/make-bg-exe.mjs <source.exe> <target.exe>');
  process.exit(1);
}

try {
  run(source, target);
} catch (error) {
  console.error(`make-bg-exe: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
