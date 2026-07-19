import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server.js";

const apiRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(apiRoot, "..");

export default createApp({
  database: process.env.FORMA_DB || process.env.MONEYFY_DB || "/tmp/forma.sqlite",
  uploadDir: process.env.FORMA_UPLOAD_DIR || process.env.MONEYFY_UPLOAD_DIR || "/tmp/forma-uploads",
  staticRoot: projectRoot
});
