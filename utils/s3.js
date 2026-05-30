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

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} = require("@aws-sdk/client-s3");

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

/**
 * Upload a check-in selfie photo. Object key is namespaced under
 * `checkin-photos/<role>/<userId>/<YYYY-MM-DD>/<timestamp>.jpg` so the bucket
 * lifecycle rule can target the prefix `checkin-photos/` for 7-day expiration.
 *
 * @param {Object} params
 * @param {"employee"|"manager"} params.role
 * @param {string} params.userId
 * @param {Buffer} params.buffer
 * @param {string} [params.contentType="image/jpeg"]
 * @returns {Promise<{bucket: string, key: string}>}
 */
const uploadCheckinPhoto = async ({ role, userId, buffer, contentType }) => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) throw new Error("S3_BUCKET_NAME is not set");

  const today = new Date().toISOString().split("T")[0];
  const key = `checkin-photos/${role}/${userId}/${today}/${Date.now()}.jpg`;

  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType || "image/jpeg",
    })
  );
  return { bucket, key };
};

const deleteS3Object = async ({ bucket, key }) => {
  if (!bucket || !key) return;
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};

/**
 * Apply a 7-day expiration lifecycle rule to objects under the `checkin-photos/`
 * prefix. Idempotent: merges with existing rules and only touches rule id
 * `checkin-photos-7d-expiry`.
 *
 * Requires `s3:PutLifecycleConfiguration` on the bucket.
 */
const applyCheckinPhotoLifecycle = async () => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) throw new Error("S3_BUCKET_NAME is not set");

  const client = getS3Client();
  const RULE_ID = "checkin-photos-7d-expiry";

  let existingRules = [];
  try {
    const current = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
    );
    existingRules = (current.Rules || []).filter((r) => r.ID !== RULE_ID);
  } catch (err) {
    // NoSuchLifecycleConfiguration is expected when no rules exist yet.
    if (err.name !== "NoSuchLifecycleConfiguration") throw err;
  }

  const newRule = {
    ID: RULE_ID,
    Status: "Enabled",
    Filter: { Prefix: "checkin-photos/" },
    Expiration: { Days: 7 },
  };

  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: [...existingRules, newRule] },
    })
  );

  return { bucket, ruleId: RULE_ID };
};

module.exports = {
  uploadTaskAttachment,
  sanitizeFileName,
  getS3Client,
  uploadFile,
  uploadCheckinPhoto,
  deleteS3Object,
  applyCheckinPhotoLifecycle,
};
