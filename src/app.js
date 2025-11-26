import express from "express";
import bodyParser from "body-parser";
import * as dotenv from "dotenv";
import routes from "./routes/index.js";
import {
 errorMiddleware,
 notFoundHandler,
} from "./middleware/errorMiddleware.js";
import { validateZoomConfig } from "./config/zoom.js";
import logger from "./utils/logger.js";

dotenv.config();

function createApp() {
 const app = express();

 try {
  validateZoomConfig();
  logger.info("Configuration validated successfully");
 } catch (error) {
  logger.error("Configuration validation failed", { error: error.message });
  throw error;
 }

 app.use(bodyParser.json({ limit: '15mb' }));
 app.use(bodyParser.urlencoded({ extended: true, limit: '15mb' }));

 app.use((req, _res, next) => {
  logger.info("Incoming request", {
   method: req.method,
   path: req.path,
   ip: req.ip,
  });
  next();
 });

 app.use("/api", routes);

 app.use(notFoundHandler);

 app.use(errorMiddleware);

 return app;
}

export default createApp;