import express from "express";
import axios from "axios";
import zoomConfig from "../config/zoom.js";
import pool from "../config/database.js";
import subscriptionService from "../services/subscription/subscriptionService.js";
import { asyncHandler } from "../utils/errorHandler.js";
import logger from "../utils/logger.js";
import { normalizeJid } from "../utils/jidHelper.js";
import { encryptToken, decryptToken } from "../utils/tokenEncryption.js";
import workspaceService from "../services/workspace/workspaceService.js";

const router = express.Router();

router.post(
 "/oauth/token",
 asyncHandler(async (req, res) => {
  const { code, redirectUri } = req.body;

  if (!code || !redirectUri) {
   return res.status(400).json({
    success: false,
    message: "Missing code or redirectUri",
   });
  }

  try {
   const tokenResponse = await axios.post("https://zoom.us/oauth/token", null, {
    params: {
     grant_type: "authorization_code",
     code,
     redirect_uri: redirectUri,
    },
    auth: {
     username: zoomConfig.clientId,
     password: zoomConfig.clientSecret,
    },
   });

   const { access_token, refresh_token, expires_in } = tokenResponse.data;

   const userResponse = await axios.get("https://api.zoom.us/v2/users/me", {
    headers: {
     Authorization: `Bearer ${access_token}`,
    },
   });

   const user = userResponse.data;

   let baseId;

   if (user.id.includes("@") && user.id.includes(".")) {
    baseId = user.id.split("@")[0];
    logger.warn("user.id appears to be email, extracting base ID", {
     userId: user.id,
     extractedBaseId: baseId,
    });
   } else {
    baseId = user.id.replace(/@xmpp\.zoom\.us$/i, "");
   }

   const userJid = normalizeJid(baseId);

   logger.info("Constructed userJid from OAuth", {
    originalUserId: user.id,
    baseId,
    normalizedJid: userJid,
    email: user.email,
    accountId: user.account_id,
   });

   const workspace = await workspaceService.getOrCreateWorkspace(
    user.account_id,
    `${user.account_id} Workspace`
   );

   logger.info("Workspace created/retrieved", {
    workspaceId: workspace.workspace_id,
    zoomAccountId: user.account_id,
   });

   let tier = "free";
   if (user.type === 2 || user.type === 3) {
    tier = "premium";
   }

   const encryptedAccessToken = encryptToken(access_token);
   const encryptedRefreshToken = encryptToken(refresh_token);

   await pool.query(
    `
        INSERT INTO users (
          user_jid, 
          email, 
          first_name, 
          last_name, 
          zoom_user_id,
          zoom_account_id,
          zoom_user_type,
          access_token,
          refresh_token,
          token_expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + INTERVAL '1 hour')
        ON CONFLICT (user_jid) 
        DO UPDATE SET
          email = $2,
          first_name = $3,
          last_name = $4,
          zoom_user_id = $5,
          zoom_account_id = $6,
          zoom_user_type = $7,
          access_token = $8,
          refresh_token = $9,
          token_expires_at = NOW() + INTERVAL '1 hour',
          updated_at = CURRENT_TIMESTAMP
        `,
    [
     userJid,
     user.email,
     user.first_name,
     user.last_name,
     user.id,
     user.account_id,
     user.type,
     encryptedAccessToken,
     encryptedRefreshToken,
    ]
   );

   const userRole = user.type === 2 || user.type === 3 ? "admin" : "member";
   await workspaceService.addUserToWorkspace(
    workspace.workspace_id,
    userJid,
    userRole
   );

   logger.info("User added to workspace", {
    userJid,
    workspaceId: workspace.workspace_id,
    role: userRole,
   });

   await subscriptionService.setUserTier(userJid, tier);

   logger.info("User authenticated successfully", {
    userJid,
    tier,
    workspaceId: workspace.workspace_id,
   });

   res.status(200).json({
    success: true,
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresIn: expires_in,
    user: {
     id: user.id,
     userJid: userJid,
     email: user.email,
     firstName: user.first_name,
     lastName: user.last_name,
     type: user.type,
    },
    workspace: {
     id: workspace.workspace_id,
     name: workspace.name,
    },
   });
  } catch (error) {
   logger.error("OAuth token exchange failed", {
    error: error.message,
    response: error.response?.data,
   });

   res.status(500).json({
    success: false,
    message: "Failed to authenticate with Zoom",
   });
  }
 })
);

router.post(
 "/oauth/refresh",
 asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
   return res.status(400).json({
    success: false,
    message: "Missing refresh token",
   });
  }

  try {
   const userResult = await pool.query(
    "SELECT user_jid, refresh_token FROM users WHERE refresh_token IS NOT NULL"
   );

   let userJid = null;
   for (const row of userResult.rows) {
    try {
     const decrypted = decryptToken(row.refresh_token);
     if (decrypted === refreshToken) {
      userJid = row.user_jid;
      break;
     }
    } catch (error) {
     continue;
    }
   }

   if (!userJid) {
    return res.status(401).json({
     success: false,
     message: "Invalid refresh token",
    });
   }

   const tokenResponse = await axios.post("https://zoom.us/oauth/token", null, {
    params: {
     grant_type: "refresh_token",
     refresh_token: refreshToken,
    },
    auth: {
     username: zoomConfig.clientId,
     password: zoomConfig.clientSecret,
    },
   });

   const { access_token, refresh_token, expires_in } = tokenResponse.data;

   const encryptedAccessToken = encryptToken(access_token);
   const encryptedRefreshToken = encryptToken(refresh_token);

   await pool.query(
    `
        UPDATE users 
        SET access_token = $1, 
            refresh_token = $2, 
            token_expires_at = NOW() + INTERVAL '1 hour',
            updated_at = CURRENT_TIMESTAMP
        WHERE user_jid = $3
        `,
    [encryptedAccessToken, encryptedRefreshToken, userJid]
   );

   logger.info("Token refreshed successfully");

   res.status(200).json({
    success: true,
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresIn: expires_in,
   });
  } catch (error) {
   logger.error("Token refresh failed", {
    error: error.message,
   });

   res.status(500).json({
    success: false,
    message: "Failed to refresh token",
   });
  }
 })
);

router.get(
 "/me",
 asyncHandler(async (req, res) => {
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
    "SELECT * FROM users WHERE access_token IS NOT NULL AND token_expires_at > NOW()"
   );

   let user = null;
   for (const row of result.rows) {
    try {
     const decryptedToken = decryptToken(row.access_token);
     if (decryptedToken === token) {
      user = row;
      break;
     }
    } catch (error) {
     continue;
    }
   }

   if (!user) {
    return res.status(401).json({
     success: false,
     message: "Invalid token",
    });
   }

   const tier = await subscriptionService.getUserTier(user.user_jid);

   res.status(200).json({
    success: true,
    user: {
     userJid: user.user_jid,
     email: user.email,
     firstName: user.first_name,
     lastName: user.last_name,
     tier,
    },
   });
  } catch (error) {
   logger.error("Failed to get user profile", {
    error: error.message,
   });

   res.status(500).json({
    success: false,
    message: "Failed to get user profile",
   });
  }
 })
);

export default router;
