import express from "express";
import multer from "multer";
import { Ragie } from "ragie";
import pool from "../config/database.js";
import subscriptionService from "../services/subscription/subscriptionService.js";
import { asyncHandler } from "../utils/errorHandler.js";
import logger from "../utils/logger.js";

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
   "SELECT user_jid FROM users WHERE access_token = $1 AND token_expires_at > NOW()",
   [token]
  );

  if (result.rows.length === 0) {
   return res.status(401).json({
    success: false,
    message: "Invalid or expired token",
   });
  }

  req.userJid = result.rows[0].user_jid;
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

  const tier = await subscriptionService.getUserTier(userJid);
  if (tier !== "premium") {
   return res.status(403).json({
    success: false,
    message: "Premium subscription required for file uploads",
   });
  }

  try {
   logger.info("Uploading document to Ragie", {
    userJid,
    filename: req.file.originalname,
    size: req.file.size,
   });

   const file = new File([req.file.buffer], req.file.originalname, {
    type: req.file.mimetype,
   });

   const uploadResponse = await ragieClient.documents.create({
    file: file,
    metadata: {
     userJid: userJid,
     uploadedAt: new Date().toISOString(),
    },
   });

   await pool.query(
    `
        INSERT INTO documents (
          document_id,
          user_jid,
          name,
          file_type,
          file_size,
          ragie_document_id,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
    [
     uploadResponse.id,
     userJid,
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
   });

   res.status(200).json({
    success: true,
    message: "File uploaded successfully",
    documentId: uploadResponse.id,
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

  try {
   const result = await pool.query(
    `
        SELECT 
          document_id as id,
          name,
          status,
          created_at as "createdAt",
          file_size as size,
          file_type as type
        FROM documents
        WHERE user_jid = $1
        ORDER BY created_at DESC
        `,
    [userJid]
   );

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
    "SELECT user_jid FROM documents WHERE document_id = $1",
    [documentId]
   );

   if (result.rows.length === 0) {
    return res.status(404).json({
     success: false,
     message: "Document not found",
    });
   }

   if (result.rows[0].user_jid !== userJid) {
    return res.status(403).json({
     success: false,
     message: "Access denied",
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
