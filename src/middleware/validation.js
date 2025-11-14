import logger from "../utils/logger.js";
import { AppError } from "../utils/errorHandler.js";
import zoomConfig from "../config/zoom.js";
import {
  verifyZoomSignature,
  isTimestampValid,
} from "../utils/zoomSignatureVerifier.js";

export function validateZoomWebhook(req, res, next) {
 const { event, payload } = req.body;

 if (!event) {
  logger.warn("Webhook validation failed: missing event");
  throw new AppError("Missing event in webhook payload", 400);
 }

 if (event !== "endpoint.url_validation") {
  const signature = req.headers["x-zm-signature"];
  const timestamp = req.headers["x-zm-request-timestamp"];

  if (!signature || !timestamp) {
   logger.warn("Webhook validation failed: missing signature or timestamp", {
    hasSignature: !!signature,
    hasTimestamp: !!timestamp,
   });
   throw new AppError("Missing x-zm-signature or x-zm-request-timestamp header", 401);
  }

  if (!isTimestampValid(timestamp)) {
   logger.warn("Webhook validation failed: timestamp out of range");
   throw new AppError("Request timestamp is too old or invalid", 401);
  }

  if (!zoomConfig.webhookSecret) {
   logger.error("ZOOM_WEBHOOK_SECRET_TOKEN not configured");
   throw new AppError("Webhook secret not configured", 500);
  }

  const isValidSignature = verifyZoomSignature(
   signature,
   timestamp,
   req.body,
   zoomConfig.webhookSecret
  );

  if (!isValidSignature) {
   logger.warn("Webhook validation failed: invalid signature");
   throw new AppError("Invalid webhook signature", 401);
  }

  logger.info("Webhook signature verified successfully");
 }

 if (event === "bot_notification") {
  if (!payload || !payload.cmd || !payload.toJid) {
   logger.warn("Bot notification validation failed", { payload });
   throw new AppError("Invalid bot_notification payload", 400);
  }
 }

 if (event === "endpoint.url_validation") {
  if (!payload || !payload.plainToken) {
   logger.warn("URL validation failed: missing plainToken", { payload });
   throw new AppError("Invalid url_validation payload", 400);
  }
 }

 next();
}

export function validateRequestBody(req, res, next) {
 if (!req.body || Object.keys(req.body).length === 0) {
  logger.warn("Request validation failed: empty body");
  throw new AppError("Request body is required", 400);
 }

 next();
}

export default {
 validateZoomWebhook,
 validateRequestBody,
};