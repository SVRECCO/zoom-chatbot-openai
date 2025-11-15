import express from "express";
import pool from "../config/database.js";
import workspaceService from "../services/workspace/workspaceService.js";
import { asyncHandler } from "../utils/errorHandler.js";
import logger from "../utils/logger.js";
import { decryptToken } from "../utils/tokenEncryption.js";

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

router.get(
 "/",
 verifyAuth,
 asyncHandler(async (req, res) => {
  const workspace = await workspaceService.getUserWorkspace(req.userJid);

  if (!workspace) {
   return res.status(404).json({
    success: false,
    message: "No workspace found",
   });
  }

  const members = await workspaceService.getWorkspaceMembers(
   workspace.workspace_id
  );
  const userRole = await workspaceService.getUserRole(
   req.userJid,
   workspace.workspace_id
  );

  res.status(200).json({
   success: true,
   workspace: {
    ...workspace,
    memberCount: members.length,
    members,
    userRole,
   },
  });
 })
);

router.get(
 "/members",
 verifyAuth,
 asyncHandler(async (req, res) => {
  const workspace = await workspaceService.getUserWorkspace(req.userJid);

  if (!workspace) {
   return res.status(404).json({
    success: false,
    message: "No workspace found",
   });
  }

  const members = await workspaceService.getWorkspaceMembers(
   workspace.workspace_id
  );

  res.status(200).json({
   success: true,
   members,
  });
 })
);

router.get(
 "/documents",
 verifyAuth,
 asyncHandler(async (req, res) => {
  const workspace = await workspaceService.getUserWorkspace(req.userJid);

  if (!workspace) {
   return res.status(404).json({
    success: false,
    message: "No workspace found",
   });
  }

  const result = await pool.query(
   `
      SELECT 
        d.document_id as id,
        d.name,
        d.visibility,
        d.status,
        d.created_at as "createdAt",
        d.file_size as size,
        d.file_type as type,
        u.email as uploaded_by_email,
        u.first_name || ' ' || u.last_name as uploaded_by_name
      FROM documents d
      LEFT JOIN users u ON d.uploaded_by = u.user_jid
      WHERE d.workspace_id = $1 AND d.visibility = 'workspace'
      ORDER BY d.created_at DESC
      `,
   [workspace.workspace_id]
  );

  res.status(200).json({
   success: true,
   documents: result.rows,
  });
 })
);

router.put(
 "/members/:userJid/role",
 verifyAuth,
 asyncHandler(async (req, res) => {
  const { userJid: targetUserJid } = req.params;
  const { role } = req.body;

  if (!role || !["admin", "member"].includes(role)) {
   return res.status(400).json({
    success: false,
    message: "Invalid role. Must be 'admin' or 'member'",
   });
  }

  const workspace = await workspaceService.getUserWorkspace(req.userJid);

  if (!workspace) {
   return res.status(404).json({
    success: false,
    message: "No workspace found",
   });
  }

  const isAdmin = await workspaceService.isWorkspaceAdmin(
   req.userJid,
   workspace.workspace_id
  );

  if (!isAdmin) {
   return res.status(403).json({
    success: false,
    message: "Admin access required",
   });
  }

  const hasAccess = await workspaceService.hasWorkspaceAccess(
   targetUserJid,
   workspace.workspace_id
  );

  if (!hasAccess) {
   return res.status(404).json({
    success: false,
    message: "User not found in workspace",
   });
  }

  await workspaceService.updateUserRole(
   workspace.workspace_id,
   targetUserJid,
   role
  );

  logger.info("User role updated", {
   workspaceId: workspace.workspace_id,
   targetUserJid,
   role,
   updatedBy: req.userJid,
  });

  res.status(200).json({
   success: true,
   message: "User role updated successfully",
  });
 })
);

router.delete(
 "/members/:userJid",
 verifyAuth,
 asyncHandler(async (req, res) => {
  const { userJid: targetUserJid } = req.params;

  const workspace = await workspaceService.getUserWorkspace(req.userJid);

  if (!workspace) {
   return res.status(404).json({
    success: false,
    message: "No workspace found",
   });
  }

  const isAdmin = await workspaceService.isWorkspaceAdmin(
   req.userJid,
   workspace.workspace_id
  );

  if (!isAdmin) {
   return res.status(403).json({
    success: false,
    message: "Admin access required",
   });
  }

  if (targetUserJid === req.userJid) {
   return res.status(400).json({
    success: false,
    message: "Cannot remove yourself from workspace",
   });
  }

  await workspaceService.removeUserFromWorkspace(
   workspace.workspace_id,
   targetUserJid
  );

  logger.info("User removed from workspace", {
   workspaceId: workspace.workspace_id,
   targetUserJid,
   removedBy: req.userJid,
  });

  res.status(200).json({
   success: true,
   message: "User removed from workspace successfully",
  });
 })
);

router.get(
 "/stats",
 verifyAuth,
 asyncHandler(async (req, res) => {
  const workspace = await workspaceService.getUserWorkspace(req.userJid);

  if (!workspace) {
   return res.status(404).json({
    success: false,
    message: "No workspace found",
   });
  }

  const memberCount = await pool.query(
   `SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id = $1`,
   [workspace.workspace_id]
  );

  const documentCount = await pool.query(
   `SELECT COUNT(*) as count FROM documents WHERE workspace_id = $1 AND visibility = 'workspace'`,
   [workspace.workspace_id]
  );

  const adminCount = await pool.query(
   `SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id = $1 AND role = 'admin'`,
   [workspace.workspace_id]
  );

  res.status(200).json({
   success: true,
   stats: {
    memberCount: parseInt(memberCount.rows[0].count),
    documentCount: parseInt(documentCount.rows[0].count),
    adminCount: parseInt(adminCount.rows[0].count),
   },
  });
 })
);

export default router;
