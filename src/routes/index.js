import express from "express";
import webhookRouter from "./webhook.js";
import adminRouter from "./admin.js";
import authRouter from "./auth.js";
import documentsRouter from "./documents.js";
import databaseAdminRouter from "./database-admin.js";
import workspaceRouter from "./workspace.js";

const router = express.Router();

router.get("/test", (req, res) => {
 res.status(200).json({
  status: "ok",
  message: "Zoom RAG Chatbot API",
  timestamp: new Date().toISOString(),
 });
});

router.get("/health", (req, res) => {
 res.status(200).json({
  status: "healthy",
  timestamp: new Date().toISOString(),
 });
});

router.use("/webhook", webhookRouter);

router.use("/auth", authRouter);

router.use("/documents", documentsRouter);

router.use("/admin", adminRouter);

router.use("/admin/database", databaseAdminRouter);

router.use("/workspace", workspaceRouter);

export default router;
