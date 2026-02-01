/*
  utils/s3.js

  Purpose:
  - Centralizes AWS S3 upload logic for task attachments.

  Configuration (via .env):
  - AWS_REGION
  - AWS_ACCESS_KEY_ID
  - AWS_SECRET_ACCESS_KEY
  - S3_BUCKET_NAME

  Notes:
  - This file intentionally keeps credentials out of code. Use IAM keys locally
    and an IAM role / managed identity in production.
  - Uploads use keys like: tasks/<taskId>/<timestamp>-<safeFileName>
*/

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const getS3Client = () => {
  const region = process.env.AWS_REGION;
  if (!region) throw new Error("AWS_REGION is not set");

  // Prefer default AWS credential resolution in production environments.
  // For local dev, allow explicit keys.
  const hasExplicitCreds =
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;
  const config = { region };

  if (hasExplicitCreds) {
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }

  return new S3Client(config);
};

const sanitizeFileName = (name = "file") => {
  // Keep it simple: remove path separators and weird control chars.
  return String(name).replace(/[\\/]/g, "_").replace(/\s+/g, " ").trim();
};

/**
 * Upload a buffer to S3 under a task folder.
 *
 * @param {Object} params
 * @param {string} params.taskId - Task.taskID value (human-friendly) or Mongo _id.
 * @param {Buffer} params.buffer - File bytes.
 * @param {string} params.originalName - Original file name.
 * @param {string} [params.contentType] - MIME type.
 * @returns {Promise<{bucket: string, key: string, fileName: string}>}
 */
const uploadTaskAttachment = async ({
  taskId,
  buffer,
  originalName,
  contentType,
}) => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) throw new Error("S3_BUCKET_NAME is not set");

  const safeName = sanitizeFileName(originalName);
  const key = `tasks/${taskId}/${Date.now()}-${safeName}`;

  const client = getS3Client();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || "application/octet-stream",
  });

  await client.send(command);

  return { bucket, key, fileName: safeName };
};

/**
 * Generic upload of a buffer to S3.
 *
 * @param {Object} params
 * @param {string} params.folder - Folder prefix (e.g., 'blogs', 'avatars').
 * @param {Buffer} params.buffer - File bytes.
 * @param {string} params.originalName - Original file name.
 * @param {string} [params.contentType] - MIME type.
 * @returns {Promise<{bucket: string, key: string, location: string}>}
 */
const uploadFile = async ({
  folder,
  buffer,
  originalName,
  contentType,
}) => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) throw new Error("S3_BUCKET_NAME is not set");

  const safeName = sanitizeFileName(originalName);
  const key = `${folder}/${Date.now()}-${safeName}`;

  const client = getS3Client();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || "application/octet-stream",
  });

  await client.send(command);

  // Return generic info plus the Location equivalent (key)
  return { bucket, key, url: key }; // We return key as url for consistency with specific internal logic if needed, or we can construct full URL
};

module.exports = { uploadTaskAttachment, sanitizeFileName, getS3Client, uploadFile };
