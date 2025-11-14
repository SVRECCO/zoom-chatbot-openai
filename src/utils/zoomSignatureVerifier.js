import crypto from "crypto";
import logger from "./logger.js";

/**
 * @param {string} signature - The x-zm-signature header from the request
 * @param {string} timestamp - The x-zm-request timestamp header from the request
 * @param {Object} body - The request body
 * @param {string} secretToken - Your Zoom webhook secret token
 * @returns {boolean} - True if signature is valid
 */
export function verifyZoomSignature(signature, timestamp, body, secretToken) {
 if (!signature || !timestamp || !body || !secretToken) {
  logger.warn("Missing required parameters for signature verification", {
   hasSignature: !!signature,
   hasTimestamp: !!timestamp,
   hasBody: !!body,
   hasSecretToken: !!secretToken,
  });
  return false;
 }

 try {
  const message = `v0:${timestamp}:${JSON.stringify(body)}`;

  const hmac = crypto.createHmac("sha256", secretToken);
  hmac.update(message);
  const expectedSignature = `v0=${hmac.digest("hex")}`;

  const isValid = crypto.timingSafeEqual(
   Buffer.from(signature),
   Buffer.from(expectedSignature)
  );

  if (!isValid) {
   logger.warn("Invalid Zoom webhook signature", {
    expectedPrefix: expectedSignature.substring(0, 10),
    receivedPrefix: signature.substring(0, 10),
   });
  }

  return isValid;
 } catch (error) {
  logger.error("Error verifying Zoom signature", {
   error: error.message,
  });
  return false;
 }
}

export function isTimestampValid(timestamp) {
 if (!timestamp) {
  return false;
 }

 const requestTime = parseInt(timestamp, 10);
 const currentTime = Math.floor(Date.now() / 1000);
 const timeDiff = Math.abs(currentTime - requestTime);

 const MAX_TIME_DIFF = 5 * 60;

 if (timeDiff > MAX_TIME_DIFF) {
  logger.warn("Timestamp outside acceptable range", {
   timeDiff,
   maxAllowed: MAX_TIME_DIFF,
  });
  return false;
 }

 return true;
}

export default {
 verifyZoomSignature,
 isTimestampValid,
};
