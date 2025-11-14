import express from "express";
import pool from "../config/database.js";
import subscriptionService from "../services/subscription/subscriptionService.js";
import { asyncHandler } from "../utils/errorHandler.js";
import logger from "../utils/logger.js";

const router = express.Router();

const verifyAuth = async (req, res, next) => {
 const authHeader = req.headers.authorization;

 if (!authHeader || !authHeader.startsWith("Bearer ")) {
  return res.status(401).json({
   success: false,
   message: "No token provided",
  });
 }

 const token = authHeader.substring(7);

 try {
  const result = await pool.query(
   "SELECT user_jid, email, access_token FROM users WHERE token_expires_at > NOW()"
  );

  let matchedUser = null;
  for (const row of result.rows) {
   try {
    const decryptedToken = decryptToken(row.access_token);
    if (decryptedToken === token) {
     matchedUser = row;
     break;
    }
   } catch (error) {
    continue;
   }
  }

  if (!matchedUser) {
   return res.status(401).json({
    success: false,
    message: "Invalid or expired token",
   });
  }

  req.userJid = matchedUser.user_jid;
  req.userEmail = matchedUser.email;
  next();
 } catch (error) {
  logger.error("Auth verification failed", { error: error.message });
  res.status(500).json({
   success: false,
   message: "Authentication failed",
  });
 }
};

const verifyAdmin = async (req, res, next) => {
 const adminEmails = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase());

 const userEmail = (req.userEmail || "").toLowerCase();

 logger.info("Admin check", {
  userJid: req.userJid,
  userEmail: userEmail,
  configuredAdmins: adminEmails,
  isAdmin: adminEmails.includes(userEmail),
 });

 if (!adminEmails.includes(userEmail)) {
  logger.warn("Admin access denied", {
   userJid: req.userJid,
   userEmail: userEmail,
  });
  return res.status(403).json({
   success: false,
   message: "Admin access required",
   debug: {
    yourEmail: userEmail,
    yourUserJid: req.userJid,
    configuredAdmins: adminEmails,
   },
  });
 }

 logger.info("Admin access granted", {
  userJid: req.userJid,
  userEmail: userEmail,
 });
 next();
};

router.get(
 "/subscription/:userJid",
 asyncHandler(async (req, res) => {
  const { userJid } = req.params;

  const tier = await subscriptionService.getUserTier(userJid);
  const config = subscriptionService.getTierConfig(tier);

  res.status(200).json({
   success: true,
   data: {
    userJid,
    tier,
    config,
   },
  });
 })
);

router.put(
 "/subscription/:userJid",
 verifyAuth,
 verifyAdmin,
 asyncHandler(async (req, res) => {
  const { userJid } = req.params;
  const { tier } = req.body;

  if (!tier || !["free", "premium"].includes(tier)) {
   return res.status(400).json({
    success: false,
    error: "Invalid tier. Must be 'free' or 'premium'",
   });
  }

  await subscriptionService.setUserTier(userJid, tier);

  logger.info("User subscription updated", {
   userJid,
   tier,
   updatedBy: req.userEmail,
  });

  res.status(200).json({
   success: true,
   message: "Subscription tier updated successfully",
   data: {
    userJid,
    tier,
   },
  });
 })
);

router.get(
 "/tiers",
 asyncHandler(async (req, res) => {
  const tiers = subscriptionService.getAllTiers();

  res.status(200).json({
   success: true,
   data: tiers,
  });
 })
);

router.get(
 "/subscription/:userJid/features",
 asyncHandler(async (req, res) => {
  const { userJid } = req.params;

  const tier = await subscriptionService.getUserTier(userJid);
  const hasRag = await subscriptionService.hasFeatureAccess(userJid, "rag");
  const hasTools = await subscriptionService.hasFeatureAccess(userJid, "tools");
  const enabledTools = await subscriptionService.getEnabledTools(userJid);
  const description = await subscriptionService.getTierDescription(userJid);

  res.status(200).json({
   success: true,
   data: {
    userJid,
    tier,
    features: {
     rag_enabled: hasRag,
     tools_enabled: hasTools,
     enabled_tools: enabledTools,
    },
    description,
   },
  });
 })
);

router.get(
 "/users",
 verifyAuth,
 verifyAdmin,
 asyncHandler(async (req, res) => {
  const result = await pool.query(`
      SELECT 
        u.user_jid,
        u.email,
        u.first_name,
        u.last_name,
        u.zoom_user_type,
        COALESCE(us.tier, 'free') as tier,
        u.created_at
      FROM users u
      LEFT JOIN user_subscriptions us ON u.user_jid = us.user_jid
      ORDER BY u.created_at DESC
    `);

  logger.info("Users list retrieved", {
   userEmail: req.userEmail,
   userCount: result.rows.length,
  });

  res.status(200).json({
   success: true,
   users: result.rows,
  });
 })
);

router.get(
 "/stats",
 verifyAuth,
 verifyAdmin,
 asyncHandler(async (req, res) => {
  const tierStats = await pool.query(`
      SELECT 
        COALESCE(us.tier, 'free') as tier,
        COUNT(*) as count
      FROM users u
      LEFT JOIN user_subscriptions us ON u.user_jid = us.user_jid
      GROUP BY COALESCE(us.tier, 'free')
    `);

  const docStats = await pool.query(`
      SELECT COUNT(*) as total_documents
      FROM documents
    `);

  const docsByUser = await pool.query(`
      SELECT 
        user_jid,
        COUNT(*) as document_count
      FROM documents
      GROUP BY user_jid
      ORDER BY document_count DESC
      LIMIT 10
    `);

  logger.info("Admin stats retrieved", {
   userEmail: req.userEmail,
  });

  res.status(200).json({
   success: true,
   stats: {
    usersByTier: tierStats.rows,
    totalDocuments: parseInt(docStats.rows[0].total_documents),
    topDocumentUsers: docsByUser.rows,
   },
  });
 })
);

export default router;
