import crypto from "node:crypto";
import { getLogger } from "@/lib/logging/logger";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Nothing in this file logs the key, a property of the key, or a decrypted
 * value.
 *
 * It used to log all three, on the normal path: twenty-four `[ENCRYPTION
 * DEBUG]` lines per call, reporting whether `ENCRYPTION_KEY` was set, its
 * length, whether it was hex, the derived key's length — and, at the end of
 * `decrypt`, the first 200 characters of the plaintext. For a data source that
 * is the whole connection config, so every `docker compose logs` carried
 *
 *     {"host":"…","port":5432,"database":"…","user":"…","password":"…"}
 *
 * in the clear. Storing that config AES-256-GCM encrypted stops meaning
 * anything the moment the plaintext is written to a log, which is collected,
 * shipped and retained by whatever runs the process, usually under far weaker
 * access control than the row it came from.
 *
 * The key-shape lines were the same mistake one step removed: length and
 * character class are exactly what an attacker who has the logs wants to know
 * before attacking the key.
 *
 * What survives is the one line that was load-bearing — the warning that no key
 * is configured and a hard-coded development key is in use — and the failure
 * path, which reports that decryption failed without reproducing either input.
 */
/**
 * Whether an unset key is allowed to fall back to a development one.
 *
 * Only outside production, and only when explicitly asked for. There is no
 * value of this that makes a deployed installation fall back silently.
 */
function devFallbackPermitted(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ALLOW_INSECURE_ENCRYPTION === "1";
}

function getKey(): Buffer {
  const encryptionKey = process.env.ENCRYPTION_KEY;

  if (!encryptionKey) {
    /*
     * A missing key is fatal now. It used to warn and carry on with
     *
     *     scryptSync("default-dev-key-change-in-production", "salt", 32)
     *
     * which is a constant sitting in a public repository. An installation that
     * missed the variable encrypted every stored data-source credential under a
     * key anyone can derive, and the only sign of it was one line in a boot log
     * that nothing failed on — so the failure was silent in exactly the
     * deployment where it mattered most.
     *
     * `AUTH_SECRET` has refused to boot without a value since the Better Auth
     * migration (src/lib/auth/better-auth.ts). This is the same decision for
     * the same reason: a secret that is optional is a secret that will be
     * missing somewhere.
     *
     * Local development that genuinely wants the old behaviour has to ask for
     * it, out loud, and cannot do so in production.
     */
    if (devFallbackPermitted()) {
      getLogger("app").event("app.misc.degraded", { what: "ENCRYPTION_KEY is not set and ALLOW_INSECURE_ENCRYPTION=1 — " +
          "using a hard-coded development key. Stored data-source passwords are " +
          "NOT protected. Never do this outside local development." });
      return crypto.scryptSync("default-dev-key-change-in-production", "salt", KEY_LENGTH);
    }

    throw new Error(
      "[FATAL] ENCRYPTION_KEY is not set. Data-source connection configs cannot be " +
        "encrypted or decrypted without it. Generate one once, before first boot: " +
        "openssl rand -hex 32 — and then leave it alone, because rotating it leaves " +
        "every stored config undecryptable. For local development only, set " +
        "ALLOW_INSECURE_ENCRYPTION=1 to use a known development key instead."
    );
  }

  if (/^[0-9a-fA-F]+$/.test(encryptionKey) && encryptionKey.length === KEY_LENGTH * 2) {
    return Buffer.from(encryptionKey, "hex");
  }

  /*
   * A passphrase rather than a 32-byte hex key.
   *
   * The salt is derived from the key itself rather than the literal "salt" it
   * used to be. A fixed, shared salt means two installations that chose the
   * same passphrase derive the same AES key, and it makes precomputation
   * against common passphrases worth doing once for every deployment of this
   * software rather than once per deployment.
   *
   * Deriving the salt from the passphrase keeps this a pure function of the
   * environment — which it must be, since there is nowhere to store a random
   * salt that every process would agree on — while making the derivation
   * installation-specific.
   */
  const salt = crypto.createHash("sha256").update(`ers:${encryptionKey}`).digest();
  return crypto.scryptSync(encryptionKey, salt, KEY_LENGTH);
}

/**
 * The passphrase derivation this file used before the salt was made
 * installation-specific.
 *
 * Returned only so `decrypt` can try it when the current key fails. Anything
 * written from now on uses `getKey`, so a row re-saved after this change stops
 * needing it — but a row written before it must keep opening, or changing the
 * derivation would have stranded every stored connection config exactly the way
 * rotating the key does. `null` when the legacy derivation cannot apply.
 */
function getLegacyKey(): Buffer | null {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) return null;
  if (/^[0-9a-fA-F]+$/.test(encryptionKey) && encryptionKey.length === KEY_LENGTH * 2) {
    // The hex path never changed, so there is no legacy variant of it.
    return null;
  }
  return crypto.scryptSync(encryptionKey, "salt", KEY_LENGTH);
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Combine IV + AuthTag + Encrypted data
  return iv.toString("hex") + authTag.toString("hex") + encrypted;
}

function openWith(key: Buffer, iv: Buffer, authTag: Buffer, encrypted: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function decrypt(ciphertext: string): string {
  const key = getKey();

  const minimumLength = (IV_LENGTH + AUTH_TAG_LENGTH) * 2;
  if (ciphertext.length < minimumLength) {
    // The length is the diagnosis; the ciphertext itself adds nothing to it.
    throw new Error(
      `Invalid ciphertext length: ${ciphertext.length}. Expected at least ${minimumLength} characters (IV + auth tag).`
    );
  }

  try {
    const iv = Buffer.from(ciphertext.slice(0, IV_LENGTH * 2), "hex");
    const authTag = Buffer.from(
      ciphertext.slice(IV_LENGTH * 2, (IV_LENGTH + AUTH_TAG_LENGTH) * 2),
      "hex"
    );
    const encrypted = ciphertext.slice((IV_LENGTH + AUTH_TAG_LENGTH) * 2);

    try {
      return openWith(key, iv, authTag, encrypted);
    } catch (currentKeyError) {
      // A row written before the passphrase salt became installation-specific.
      // Tried second, so the current derivation stays the fast path, and only
      // when there is a legacy derivation to try at all.
      const legacy = getLegacyKey();
      if (!legacy) throw currentKeyError;
      return openWith(legacy, iv, authTag, encrypted);
    }
  } catch (error) {
    // The message and name are enough to tell a wrong key from a corrupt row.
    // Neither the ciphertext nor anything derived from the key goes in.
    getLogger("app").event("app.misc.failed", { what: "Decryption failed", detail: [error instanceof Error ? `${error.name}: ${error.message}` : String(error)] });
    throw error;
  }
}

/*
 * `hashPassword` and `verifyPassword` used to live here, PBKDF2-based and
 * referenced by nothing.
 *
 * They are deleted rather than fixed. `verifyPassword` compared digests with
 * `===`, which is not constant-time — but the reason to remove them is that
 * this application's passwords are bcrypt, hashed and checked by the hooks in
 * src/lib/auth/better-auth.ts against `auth_accounts.password`. A second,
 * unused password implementation in the file named "encryption" is an
 * invitation to call the wrong one, and an account written by it could not sign
 * in: the failure would read as a wrong password rather than as the wrong
 * algorithm.
 *
 * If something here needs to hash a password, it wants BCRYPT_COST and
 * bcryptjs, the way bootstrap.ts and the admin server functions do.
 */

export function generateApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString("base64url");
}
