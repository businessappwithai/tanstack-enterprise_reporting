/**
 * The platform logs through the spec, and answers API failures through one wrapper.
 *
 * Both were conventions that held for a month and then did not: 530 `console.*` calls had
 * accumulated across 158 files, and 82 API routes each wrote their own error body. A static
 * scan is the check that keeps them from coming back, and like the other static scans in
 * this repository it is a text scan on purpose — the property is one a person can verify
 * with grep.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../../..");

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const files = walk(SRC);
const rel = (file: string) => relative(SRC, file).replaceAll("\\", "/");

/**
 * Where the console is the point: the logger itself, and the scripts whose stdout is their
 * report to the person running them (migrations, seeds, sample data).
 */
const CONSOLE_ALLOWED = [
  /^lib\/logging\//,
  /^lib\/db\/migrations\//,
  /^lib\/db\/seeds\//,
  /^lib\/db\/sample-data\//,
  /^lib\/utils\/logger\.ts$/,
];

describe("the platform's source", () => {
  it("never calls console.* outside the logger and the scripts", () => {
    const offenders = files
      .filter((file) => !CONSOLE_ALLOWED.some((allowed) => allowed.test(rel(file))))
      .filter((file) =>
        readFileSync(file, "utf-8")
          .split("\n")
          .some((line) => /\bconsole\.(log|info|warn|error|debug)\(/.test(line) && !/^\s*(\*|\/\/)/.test(line))
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("has no free-text log calls: a line is a declared event", () => {
    // `note(level, text)` carried 344 console calls through the move to the logger without ids.
    // It is gone; this keeps it gone.
    const offenders = files
      .filter((file) => !/^lib\/logging\//.test(rel(file)))
      .filter((file) => /\.note\(/.test(readFileSync(file, "utf-8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("never logs a recipient's address from the email batch", () => {
    const worker = readFileSync(join(SRC, "lib/jobs/workers/email-batch-worker.ts"), "utf-8");
    const loggedLines = worker.split("\n").filter((line) => /getLogger\(/.test(line));
    expect(loggedLines.some((line) => /recipientEmail|failedRecipients/.test(line))).toBe(false);
  });

  it("does not write a generated password into the structured log", () => {
    const bootstrap = readFileSync(join(SRC, "lib/db/bootstrap.ts"), "utf-8");
    const loggedLines = bootstrap.split("\n").filter((line) => /getLogger\(/.test(line));
    expect(loggedLines.some((line) => /generated\b(?!\s*:)/.test(line) && /\$\{generated\}/.test(line))).toBe(false);
    expect(bootstrap).toContain("process.stderr.write(");
  });

  it("wraps every API route's handlers in withApiHandler", () => {
    // The WebSocket upgrade answers 101 and keeps the connection; a wrapper that rewrites the
    // response has no place there.
    const UPGRADE = new Set(["routes/api/voice/ws.ts"]);
    const unwrapped = files
      .filter((file) => rel(file).startsWith("routes/api/"))
      .filter((file) => !UPGRADE.has(rel(file)))
      .filter((file) => /createFileRoute\(/.test(readFileSync(file, "utf-8")))
      .filter((file) => !readFileSync(file, "utf-8").includes("withApiHandler"))
      .map(rel);
    expect(unwrapped).toEqual([]);
  });

  it("never sends error.message in a response body from a route", () => {
    // `message: error.message` is how a driver's text, or a path, reached a caller. A route
    // throws serverFailure(error, "what failed") and the wrapper decides what is shown.
    const offenders = files
      .filter((file) => rel(file).startsWith("routes/api/"))
      .filter((file) =>
        /message:\s*(?:(?:error|err|e|ex|exception) instanceof Error \? (?:error|err|e|ex|exception)\.message|(?:error|err|e|ex|exception)\??\.message)\b/.test(readFileSync(file, "utf-8"))
      )
      .map(rel);
    expect(offenders.sort()).toEqual([]);
  });
});
