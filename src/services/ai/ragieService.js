import { Ragie } from "ragie";
import * as dotenv from "dotenv";
import logger from "../../utils/logger.js";
import { AppError } from "../../utils/errorHandler.js";

dotenv.config();

class RagieService {
 constructor() {
  if (!process.env.RAGIE_API_KEY) {
   throw new Error("RAGIE_API_KEY is not set in environment variables");
  }

  this.client = new Ragie({
   auth: process.env.RAGIE_API_KEY,
  });
 }

 async retrieveContext(
  query,
  userJid = null,
  workspaceId = null,
  maxResults = 5
 ) {
  try {
   logger.info("Retrieving context from Ragie", {
    query,
    userJid,
    workspaceId,
    maxResults,
   });

   const retrievalParams = {
    query,
    topK: maxResults,
   };

   if (userJid || workspaceId) {
    const filters = [];

    if (userJid) {
     filters.push({
      userJid: userJid,
      visibility: "private",
     });
    }

    if (workspaceId) {
     filters.push({
      workspaceId: workspaceId,
      visibility: "workspace",
     });
    }

    if (filters.length > 1) {
     retrievalParams.filter = { $or: filters };
    } else if (filters.length === 1) {
     retrievalParams.filter = filters[0];
    }
   }

   const response = await this.client.retrievals.retrieve(retrievalParams);

   if (!response.scoredChunks || response.scoredChunks.length === 0) {
    logger.warn("No chunks retrieved from Ragie", {
     query,
     userJid,
     workspaceId,
    });
    return "";
   }

   const chunkTexts = response.scoredChunks.map((chunk) => chunk.text);
   const concatenatedText = chunkTexts.join("\n\n");

   logger.info("Successfully retrieved context from Ragie", {
    query,
    userJid,
    workspaceId,
    chunksCount: chunkTexts.length,
   });

   return concatenatedText;
  } catch (error) {
   logger.error("Error retrieving context from Ragie", {
    query,
    userJid,
    workspaceId,
    error: error.message,
   });
   throw new AppError("Failed to retrieve context from Ragie", 500, { query });
  }
 }

 async getDocument(documentId) {
  try {
   logger.info("Retrieving document from Ragie", { documentId });

   const document = await this.client.documents.get({ documentId });

   logger.info("Successfully retrieved document from Ragie", { documentId });
   return document;
  } catch (error) {
   logger.error("Error retrieving document from Ragie", {
    documentId,
    error: error.message,
   });
   throw new AppError("Failed to retrieve document from Ragie", 500, {
    documentId,
   });
  }
 }
}

const ragieService = new RagieService();
export default ragieService;
