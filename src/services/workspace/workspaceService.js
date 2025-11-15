import pool from "../../config/database.js";
import logger from "../../utils/logger.js";
import { AppError } from "../../utils/errorHandler.js";

class WorkspaceService {
 async getOrCreateWorkspace(zoomAccountId, name = null) {
  try {
   const workspaceName = name || `${zoomAccountId} Workspace`;

   const result = await pool.query(
    `
        INSERT INTO workspaces (zoom_account_id, name)
        VALUES ($1, $2)
        ON CONFLICT (zoom_account_id) 
        DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        RETURNING *
        `,
    [zoomAccountId, workspaceName]
   );

   return result.rows[0];
  } catch (error) {
   logger.error("Error getting/creating workspace", {
    zoomAccountId,
    error: error.message,
   });
   throw error;
  }
 }

 async getUserWorkspace(userJid) {
  try {
   const result = await pool.query(
    `
        SELECT w.* 
        FROM workspaces w
        JOIN workspace_members wm ON w.workspace_id = wm.workspace_id
        WHERE wm.user_jid = $1
        `,
    [userJid]
   );

   if (result.rows.length === 0) {
    return null;
   }

   return result.rows[0];
  } catch (error) {
   logger.error("Error getting user workspace", {
    userJid,
    error: error.message,
   });
   throw error;
  }
 }

 async addUserToWorkspace(workspaceId, userJid, role = "member") {
  try {
   await pool.query(
    `
        INSERT INTO workspace_members (workspace_id, user_jid, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (workspace_id, user_jid) 
        DO UPDATE SET role = $3, created_at = CURRENT_TIMESTAMP
        `,
    [workspaceId, userJid, role]
   );

   logger.info("User added to workspace", {
    workspaceId,
    userJid,
    role,
   });
  } catch (error) {
   logger.error("Error adding user to workspace", {
    workspaceId,
    userJid,
    error: error.message,
   });
   throw error;
  }
 }

 async isWorkspaceAdmin(userJid, workspaceId) {
  try {
   const result = await pool.query(
    `
        SELECT role 
        FROM workspace_members 
        WHERE user_jid = $1 AND workspace_id = $2
        `,
    [userJid, workspaceId]
   );

   return result.rows.length > 0 && result.rows[0].role === "admin";
  } catch (error) {
   logger.error("Error checking workspace admin", {
    userJid,
    workspaceId,
    error: error.message,
   });
   return false;
  }
 }

 async getUserRole(userJid, workspaceId) {
  try {
   const result = await pool.query(
    `
        SELECT role 
        FROM workspace_members 
        WHERE user_jid = $1 AND workspace_id = $2
        `,
    [userJid, workspaceId]
   );

   return result.rows.length > 0 ? result.rows[0].role : null;
  } catch (error) {
   logger.error("Error getting user role", {
    userJid,
    workspaceId,
    error: error.message,
   });
   return null;
  }
 }

 async getWorkspaceMembers(workspaceId) {
  try {
   const result = await pool.query(
    `
        SELECT 
          u.user_jid, 
          u.email, 
          u.first_name, 
          u.last_name, 
          wm.role,
          wm.created_at as joined_at
        FROM workspace_members wm
        JOIN users u ON wm.user_jid = u.user_jid
        WHERE wm.workspace_id = $1
        ORDER BY wm.role DESC, u.first_name ASC
        `,
    [workspaceId]
   );

   return result.rows;
  } catch (error) {
   logger.error("Error getting workspace members", {
    workspaceId,
    error: error.message,
   });
   throw error;
  }
 }

 async removeUserFromWorkspace(workspaceId, userJid) {
  try {
   await pool.query(
    `
        DELETE FROM workspace_members 
        WHERE workspace_id = $1 AND user_jid = $2
        `,
    [workspaceId, userJid]
   );

   logger.info("User removed from workspace", {
    workspaceId,
    userJid,
   });
  } catch (error) {
   logger.error("Error removing user from workspace", {
    workspaceId,
    userJid,
    error: error.message,
   });
   throw error;
  }
 }

 async updateUserRole(workspaceId, userJid, newRole) {
  if (!["admin", "member"].includes(newRole)) {
   throw new AppError("Invalid role. Must be 'admin' or 'member'", 400);
  }

  try {
   await pool.query(
    `
        UPDATE workspace_members 
        SET role = $1 
        WHERE workspace_id = $2 AND user_jid = $3
        `,
    [newRole, workspaceId, userJid]
   );

   logger.info("User role updated", {
    workspaceId,
    userJid,
    newRole,
   });
  } catch (error) {
   logger.error("Error updating user role", {
    workspaceId,
    userJid,
    newRole,
    error: error.message,
   });
   throw error;
  }
 }

 async getWorkspaceById(workspaceId) {
  try {
   const result = await pool.query(
    `SELECT * FROM workspaces WHERE workspace_id = $1`,
    [workspaceId]
   );

   return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
   logger.error("Error getting workspace by ID", {
    workspaceId,
    error: error.message,
   });
   throw error;
  }
 }

 async hasWorkspaceAccess(userJid, workspaceId) {
  try {
   const result = await pool.query(
    `
        SELECT 1 
        FROM workspace_members 
        WHERE user_jid = $1 AND workspace_id = $2
        `,
    [userJid, workspaceId]
   );

   return result.rows.length > 0;
  } catch (error) {
   logger.error("Error checking workspace access", {
    userJid,
    workspaceId,
    error: error.message,
   });
   return false;
  }
 }
}

const workspaceService = new WorkspaceService();
export default workspaceService;
