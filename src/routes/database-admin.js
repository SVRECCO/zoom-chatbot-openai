import express from "express";
import pool from "../config/database.js";
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
   adminEmails: adminEmails,
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
 "/tables",
 verifyAuth,
 verifyAdmin,
 asyncHandler(async (req, res) => {
  const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

  const tables = result.rows.map((row) => row.table_name);

  logger.info("Tables list retrieved", {
   userEmail: req.userEmail,
   tableCount: tables.length,
  });

  res.status(200).json({
   success: true,
   tables,
  });
 })
);

router.get(
 "/tables/:tableName/schema",
 verifyAuth,
 verifyAdmin,
 asyncHandler(async (req, res) => {
  const { tableName } = req.params;

  const result = await pool.query(
   `
      SELECT 
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' 
      AND table_name = $1
      ORDER BY ordinal_position
    `,
   [tableName]
  );

  logger.info("Table schema retrieved", {
   userEmail: req.userEmail,
   tableName,
   columnCount: result.rows.length,
  });

  res.status(200).json({
   success: true,
   schema: result.rows,
  });
 })
);

router.get(
 "/tables/:tableName/data",
 verifyAuth,
 verifyAdmin,
 asyncHandler(async (req, res) => {
  const { tableName } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;

  const tableCheck = await pool.query(
   `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = $1
    `,
   [tableName]
  );

  if (tableCheck.rows.length === 0) {
   return res.status(404).json({
    success: false,
    message: "Table not found",
   });
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM "${tableName}"`);
  const total = parseInt(countResult.rows[0].count);

  const dataResult = await pool.query(
   `SELECT * FROM "${tableName}" LIMIT $1 OFFSET $2`,
   [limit, offset]
  );

  const columns = dataResult.fields.map((field) => field.name);

  logger.info("Table data retrieved", {
   userEmail: req.userEmail,
   tableName,
   page,
   limit,
   total,
  });

  res.status(200).json({
   success: true,
   columns,
   rows: dataResult.rows,
   total,
   page,
   limit,
  });
 })
);

router.post(
 "/tables/:tableName/rows",
 verifyAuth,
 verifyAdmin,
 asyncHandler(async (req, res) => {
  const { tableName } = req.params;
  const { data } = req.body;

  if (!data || typeof data !== "object") {
   return res.status(400).json({
    success: false,
    message: "Invalid data format",
   });
  }

  const tableCheck = await pool.query(
   `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = $1
    `,
   [tableName]
  );

  if (tableCheck.rows.length === 0) {
   return res.status(404).json({
    success: false,
    message: "Table not found",
   });
  }

  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

  const query = `
      INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(", ")})
      VALUES (${placeholders})
      RETURNING *
    `;

  const result = await pool.query(query, values);

  logger.info("Row inserted", {
   userEmail: req.userEmail,
   tableName,
   columns,
  });

  res.status(201).json({
   success: true,
   message: "Row inserted successfully",
   row: result.rows[0],
  });
 })
);

router.put(
 "/tables/:tableName/rows",
 verifyAuth,
 verifyAdmin,
 asyncHandler(async (req, res) => {
  const { tableName } = req.params;
  const { primaryKey, primaryKeyValue, data } = req.body;

  if (!primaryKey || primaryKeyValue === undefined || !data) {
   return res.status(400).json({
    success: false,
    message: "Missing required fields: primaryKey, primaryKeyValue, data",
   });
  }

  const tableCheck = await pool.query(
   `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = $1
    `,
   [tableName]
  );

  if (tableCheck.rows.length === 0) {
   return res.status(404).json({
    success: false,
    message: "Table not found",
   });
  }

  const updates = Object.keys(data)
   .map((key, i) => `"${key}" = $${i + 1}`)
   .join(", ");

  const values = [...Object.values(data), primaryKeyValue];

  const query = `
      UPDATE "${tableName}"
      SET ${updates}
      WHERE "${primaryKey}" = $${values.length}
      RETURNING *
    `;

  const result = await pool.query(query, values);

  if (result.rows.length === 0) {
   return res.status(404).json({
    success: false,
    message: "Row not found",
   });
  }

  logger.info("Row updated", {
   userEmail: req.userEmail,
   tableName,
   primaryKey,
   primaryKeyValue,
  });

  res.status(200).json({
   success: true,
   message: "Row updated successfully",
   row: result.rows[0],
  });
 })
);

router.delete(
 "/tables/:tableName/rows",
 verifyAuth,
 verifyAdmin,
 asyncHandler(async (req, res) => {
  const { tableName } = req.params;
  const { primaryKey, primaryKeyValue } = req.body;

  if (!primaryKey || primaryKeyValue === undefined) {
   return res.status(400).json({
    success: false,
    message: "Missing required fields: primaryKey, primaryKeyValue",
   });
  }

  const tableCheck = await pool.query(
   `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = $1
    `,
   [tableName]
  );

  if (tableCheck.rows.length === 0) {
   return res.status(404).json({
    success: false,
    message: "Table not found",
   });
  }

  const query = `
      DELETE FROM "${tableName}"
      WHERE "${primaryKey}" = $1
      RETURNING *
    `;

  const result = await pool.query(query, [primaryKeyValue]);

  if (result.rows.length === 0) {
   return res.status(404).json({
    success: false,
    message: "Row not found",
   });
  }

  logger.info("Row deleted", {
   userEmail: req.userEmail,
   tableName,
   primaryKey,
   primaryKeyValue,
  });

  res.status(200).json({
   success: true,
   message: "Row deleted successfully",
  });
 })
);

router.post(
 "/query",
 verifyAuth,
 verifyAdmin,
 asyncHandler(async (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== "string") {
   return res.status(400).json({
    success: false,
    message: "Invalid query",
   });
  }

  const trimmedQuery = query.trim().toUpperCase();
  if (!trimmedQuery.startsWith("SELECT")) {
   return res.status(403).json({
    success: false,
    message: "Only SELECT queries are allowed",
   });
  }

  const result = await pool.query(query);
  const columns = result.fields.map((field) => field.name);

  logger.info("Custom query executed", {
   userEmail: req.userEmail,
   queryLength: query.length,
   rowCount: result.rows.length,
  });

  res.status(200).json({
   success: true,
   columns,
   rows: result.rows,
   rowCount: result.rows.length,
  });
 })
);

export default router;
