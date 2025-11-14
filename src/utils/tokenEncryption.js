import crypto from "crypto";
import logger from "./logger.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey() {
 const key = process.env.TOKEN_ENCRYPTION_KEY;

 if (!key) {
  throw new Error("TOKEN_ENCRYPTION_KEY environment variable is not set");
 }

 if (key.length !== 64) {
  throw new Error(
   "TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)"
  );
 }

 return Buffer.from(key, "hex");
}

export function encryptToken(token) {
 if (!token) {
  return null;
 }

 try {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(token, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
 } catch (error) {
  logger.error("Token encryption failed", { error: error.message });
  throw new Error("Failed to encrypt token");
 }
}

export function decryptToken(encryptedToken) {
 if (!encryptedToken) {
  return null;
 }

 try {
  const key = getEncryptionKey();
  const parts = encryptedToken.split(":");

  if (parts.length !== 3) {
   throw new Error("Invalid encrypted token format");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
 } catch (error) {
  logger.error("Token decryption failed", { error: error.message });
  throw new Error("Failed to decrypt token");
 }
}

export function generateEncryptionKey() {
 return crypto.randomBytes(32).toString("hex");
}

export default {
 encryptToken,
 decryptToken,
 generateEncryptionKey,
};
