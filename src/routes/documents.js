import express from "express";
import multer from "multer";
import { Ragie } from "ragie";
import pool from "../config/database.js";
import subscriptionService from "../services/subscription/subscriptionService.js";
import workspaceService from "../services/workspace/workspaceService.js";
import { asyncHandler } from "../utils/errorHandler.js";
import logger from "../utils/logger.js";
import { decryptToken } from "../utils/tokenEncryption.js";

const router = express.Router();

const upload = multer({
 storage: multer.memoryStorage(),
 limits: {
  fileSize: 10 * 1024 * 1024,
 },
 fileFilter: (req, file, cb) => {
  const allowedTypes = [
   "application/pdf",
   "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
   "text/plain",
   "text/markdown",
  ];

  if (allowedTypes.includes(file.mimetype)) {
   cb(null, true);
  } else {
   cb(new Error("Invalid file type. Only PDF, DOCX, TXT, and MD are allowed."));
  }
 },
});

const ragieClient = new Ragie({
 auth: process.env.RAGIE_API_KEY,
});

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

router.post(
 "/upload",
 verifyAuth,
 upload.single("file"),
 asyncHandler(async (req, res) => {
  if (!req.file) {
   return res.status(400).json({
    success: false,
    message: "No file uploaded",
   });
  }

  const userJid = req.userJid;
  const visibility = req.body.visibility || "private";

  if (!["private", "workspace"].includes(visibility)) {
   return res.status(400).json({
    success: false,
    message: "Invalid visibility option. Must be 'private' or 'workspace'",
   });
  }

  const tier = await subscriptionService.getUserTier(userJid);
  if (tier !== "premium") {
   return res.status(403).json({
    success: false,
    message: "Premium subscription required for file uploads",
   });
  }

  let workspaceId = null;
  if (visibility === "workspace") {
   const workspace = await workspaceService.getUserWorkspace(userJid);
   if (!workspace) {
    return res.status(400).json({
     success: false,
     message: "No workspace found for user",
    });
   }
   workspaceId = workspace.workspace_id;
  }

  try {
   logger.info("Uploading document to Ragie", {
    userJid,
    visibility,
    workspaceId,
    filename: req.file.originalname,
    size: req.file.size,
   });

   const file = new File([req.file.buffer], req.file.originalname, {
    type: req.file.mimetype,
   });

   const metadata = {
    uploadedBy: userJid,
    uploadedAt: new Date().toISOString(),
    visibility,
   };

   if (workspaceId) {
    metadata.workspaceId = workspaceId;
   } else {
    metadata.userJid = userJid;
   }

   const uploadResponse = await ragieClient.documents.create({
    file: file,
    metadata: metadata,
   });

   await pool.query(
    `
        INSERT INTO documents (
          document_id,
          user_jid,
          workspace_id,
          uploaded_by,
          visibility,
          name,
          file_type,
          file_size,
          ragie_document_id,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
    [
     uploadResponse.id,
     visibility === "private" ? userJid : null,
     workspaceId,
     userJid,
     visibility,
     req.file.originalname,
     req.file.mimetype,
     req.file.size,
     uploadResponse.id,
     "processing",
    ]
   );

   logger.info("Document uploaded successfully", {
    userJid,
    documentId: uploadResponse.id,
    visibility,
   });

   res.status(200).json({
    success: true,
    message: "File uploaded successfully",
    documentId: uploadResponse.id,
    visibility,
   });
  } catch (error) {
   logger.error("Document upload failed", {
    userJid,
    error: error.message,
   });

   res.status(500).json({
    success: false,
    message: "Failed to upload document",
   });
  }
 })
);

router.get(
 "/",
 verifyAuth,
 asyncHandler(async (req, res) => {
  const userJid = req.userJid;
  const scope = req.query.scope || "all";

  try {
   let query;
   let params;

   if (scope === "private") {
    query = `
          SELECT 
            document_id as id,
            name,
            visibility,
            status,
            created_at as "createdAt",
            file_size as size,
            file_type as type
          FROM documents
          WHERE user_jid = $1 AND visibility = 'private'
          ORDER BY created_at DESC
        `;
    params = [userJid];
   } else if (scope === "workspace") {
    const workspace = await workspaceService.getUserWorkspace(userJid);
    if (!workspace) {
     return res.status(200).json({
      success: true,
      documents: [],
     });
    }

    query = `
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
        `;
    params = [workspace.workspace_id];
   } else {
    const workspace = await workspaceService.getUserWorkspace(userJid);

    if (!workspace) {
     query = `
            SELECT 
              document_id as id,
              name,
              visibility,
              status,
              created_at as "createdAt",
              file_size as size,
              file_type as type,
              NULL as uploaded_by_email,
              NULL as uploaded_by_name
            FROM documents
            WHERE user_jid = $1 AND visibility = 'private'
            ORDER BY created_at DESC
          `;
     params = [userJid];
    } else {
     query = `
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
            WHERE (d.user_jid = $1 AND d.visibility = 'private')
               OR (d.workspace_id = $2 AND d.visibility = 'workspace')
            ORDER BY d.created_at DESC
          `;
     params = [userJid, workspace.workspace_id];
    }
   }

   const result = await pool.query(query, params);

   const documentsWithChunks = await Promise.all(
    result.rows.map(async (doc) => {
     try {
      const ragieDoc = await ragieClient.documents.get({
       documentId: doc.id,
      });
      return {
       ...doc,
       chunkCount: ragieDoc.chunks?.length || 0,
       status: ragieDoc.status || doc.status,
      };
     } catch (error) {
      logger.warn("Failed to get Ragie document details", {
       documentId: doc.id,
       error: error.message,
      });
      return doc;
     }
    })
   );

   res.status(200).json({
    success: true,
    documents: documentsWithChunks,
   });
  } catch (error) {
   logger.error("Failed to get documents", {
    userJid,
    error: error.message,
   });

   res.status(500).json({
    success: false,
    message: "Failed to retrieve documents",
   });
  }
 })
);

router.delete(
 "/:documentId",
 verifyAuth,
 asyncHandler(async (req, res) => {
  const { documentId } = req.params;
  const userJid = req.userJid;

  try {
   const result = await pool.query(
    `SELECT user_jid, workspace_id, uploaded_by, visibility 
         FROM documents 
         WHERE document_id = $1`,
    [documentId]
   );

   if (result.rows.length === 0) {
    return res.status(404).json({
     success: false,
     message: "Document not found",
    });
   }

   const doc = result.rows[0];

   let canDelete = false;

   if (doc.visibility === "private" && doc.user_jid === userJid) {
    canDelete = true;
   } else if (doc.visibility === "workspace") {
    if (doc.uploaded_by === userJid) {
     canDelete = true;
    } else {
     const isAdmin = await workspaceService.isWorkspaceAdmin(
      userJid,
      doc.workspace_id
     );
     canDelete = isAdmin;
    }
   }

   if (!canDelete) {
    return res.status(403).json({
     success: false,
     message:
      "Access denied. You don't have permission to delete this document.",
    });
   }

   await ragieClient.documents.delete({ documentId });

   await pool.query("DELETE FROM documents WHERE document_id = $1", [
    documentId,
   ]);

   logger.info("Document deleted successfully", {
    userJid,
    documentId,
   });

   res.status(200).json({
    success: true,
    message: "Document deleted successfully",
   });
  } catch (error) {
   logger.error("Document deletion failed", {
    userJid,
    documentId,
    error: error.message,
   });

   res.status(500).json({
    success: false,
    message: "Failed to delete document",
   });
  }
 })
);

export default router;
