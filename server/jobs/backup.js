const fs = require("fs");
const fsAsync = fs.promises;
const path = require("path");
const { createReadStream } = require("fs");
const {
    S3Client,
    HeadBucketCommand,
    PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { google } = require("googleapis");
const { R } = require("redbean-node");
const Database = require("../database");
const { Settings } = require("../settings");
const { log } = require("../../src/util");

const BACKUP_SETTING = "backupConfig";
const LAST_RUN_SETTING = "backupLastRun";
const DEFAULT_SCHEDULE_HOURS = 24;

let backupInProgress = false;

/**
 * Return the default backup configuration.
 * @returns {object} Default backup configuration
 */
function getDefaultBackupConfig() {
    return {
        enabled: false,
        provider: "disabled",
        scheduleHours: DEFAULT_SCHEDULE_HOURS,
        s3: {
            endpoint: "",
            region: "us-east-1",
            accessKeyId: "",
            secretAccessKey: "",
            bucket: "",
        },
        googleDrive: {
            serviceAccountJson: "",
            folderId: "",
        },
    };
}

/**
 * Merge stored configuration with defaults.
 * @param {object|null} config Stored configuration
 * @returns {object} Normalized backup configuration
 */
function normalizeConfig(config) {
    const defaults = getDefaultBackupConfig();
    return {
        ...defaults,
        ...(config || {}),
        s3: {
            ...defaults.s3,
            ...(config?.s3 || {}),
        },
        googleDrive: {
            ...defaults.googleDrive,
            ...(config?.googleDrive || {}),
        },
    };
}

/**
 * Validate a backup configuration.
 * @param {object} config Backup configuration
 * @returns {object} Normalized backup configuration
 * @throws {Error} If the configuration is invalid
 */
function validateConfig(config) {
    const normalizedConfig = normalizeConfig(config);

    if (!["disabled", "s3", "google-drive"].includes(normalizedConfig.provider)) {
        throw new Error("Invalid backup provider");
    }

    const scheduleHours = Number(normalizedConfig.scheduleHours);
    if (!Number.isFinite(scheduleHours) || scheduleHours < 1) {
        throw new Error("Backup interval must be at least 1 hour");
    }
    normalizedConfig.scheduleHours = scheduleHours;

    if (normalizedConfig.provider === "s3") {
        if (
            !normalizedConfig.s3.bucket ||
            !normalizedConfig.s3.region ||
            !normalizedConfig.s3.accessKeyId ||
            !normalizedConfig.s3.secretAccessKey
        ) {
            throw new Error("S3 backup configuration is incomplete");
        }
    }

    if (normalizedConfig.provider === "google-drive") {
        if (!normalizedConfig.googleDrive.serviceAccountJson) {
            throw new Error("Google Drive service account JSON is required");
        }
    }

    return normalizedConfig;
}

/**
 * Create an S3 client from backup configuration.
 * @param {object} config Backup configuration
 * @returns {S3Client} Configured S3 client
 */
function createS3Client(config) {
    return new S3Client({
        region: config.s3.region,
        endpoint: config.s3.endpoint || undefined,
        forcePathStyle: Boolean(config.s3.endpoint),
        credentials: {
            accessKeyId: config.s3.accessKeyId,
            secretAccessKey: config.s3.secretAccessKey,
        },
    });
}

/**
 * Parse Google service account credentials and create a Drive client.
 * @param {object} config Backup configuration
 * @returns {object} Google Drive client
 * @throws {Error} If the service account JSON is invalid or incomplete
 */
function createGoogleDriveClient(config) {
    let credentials;
    try {
        credentials = JSON.parse(config.googleDrive.serviceAccountJson);
    } catch (_) {
        throw new Error("Google Drive service account JSON is invalid");
    }

    if (!credentials.client_email || !credentials.private_key) {
        throw new Error("Google Drive service account JSON is incomplete");
    }

    const auth = new google.auth.JWT(
        credentials.client_email,
        null,
        credentials.private_key,
        ["https://www.googleapis.com/auth/drive"]
    );

    return google.drive({ version: "v3", auth });
}

/**
 * Test connectivity to the configured storage provider.
 * @param {object} config Backup configuration
 * @returns {Promise<void>} Resolves when the connection is valid
 */
async function testBackupConnection(config) {
    const normalizedConfig = validateConfig(config);

    if (normalizedConfig.provider === "disabled") {
        throw new Error("Select a backup provider first");
    }

    if (normalizedConfig.provider === "s3") {
        const client = createS3Client(normalizedConfig);
        await client.send(new HeadBucketCommand({ Bucket: normalizedConfig.s3.bucket }));
        return;
    }

    const drive = createGoogleDriveClient(normalizedConfig);
    const folderId = normalizedConfig.googleDrive.folderId;
    if (folderId) {
        await drive.files.get({ fileId: folderId, fields: "id, mimeType" });
    } else {
        await drive.about.get({ fields: "user(emailAddress)" });
    }
}

/**
 * Upload a backup file to S3.
 * @param {string} filePath Backup file path
 * @param {object} config Backup configuration
 * @param {string} fileName Backup file name
 * @returns {Promise<object>} Upload result
 */
async function uploadToS3(filePath, config, fileName) {
    const client = createS3Client(config);
    const key = `uptime-kuma/${fileName}`;

    await client.send(
        new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
            Body: createReadStream(filePath),
            ContentType: "application/vnd.sqlite3",
        })
    );

    return { provider: "s3", key };
}

/**
 * Upload a backup file to Google Drive.
 * @param {string} filePath Backup file path
 * @param {object} config Backup configuration
 * @param {string} fileName Backup file name
 * @returns {Promise<object>} Upload result
 */
async function uploadToGoogleDrive(filePath, config, fileName) {
    const drive = createGoogleDriveClient(config);
    const requestBody = {
        name: fileName,
        mimeType: "application/vnd.sqlite3",
    };

    if (config.googleDrive.folderId) {
        requestBody.parents = [config.googleDrive.folderId];
    }

    const result = await drive.files.create({
        requestBody,
        media: {
            mimeType: "application/vnd.sqlite3",
            body: createReadStream(filePath),
        },
        fields: "id, name",
        supportsAllDrives: true,
    });

    return { provider: "google-drive", fileId: result.data.id, name: result.data.name };
}

/**
 * Create and upload a safe SQLite database snapshot.
 * @param {object} config Backup configuration
 * @returns {Promise<object>} Upload result
 */
async function createDatabaseBackup(config) {
    if (backupInProgress) {
        throw new Error("A database backup is already in progress");
    }

    const normalizedConfig = validateConfig(config);
    if (normalizedConfig.provider === "disabled") {
        throw new Error("Select a backup provider first");
    }
    if (Database.dbConfig.type !== "sqlite") {
        throw new Error("Native database backups are currently supported for SQLite only");
    }

    backupInProgress = true;
    const temporaryBackupPath = path.join(Database.dataDir, "temp-backup.db");
    const fileName = `kuma-${new Date().toISOString().replace(/[.:]/g, "-")}.db`;

    try {
        await fsAsync.rm(temporaryBackupPath, { force: true });
        const escapedPath = temporaryBackupPath.replaceAll("'", "''");
        await R.knex.raw(`VACUUM INTO '${escapedPath}'`);

        if (normalizedConfig.provider === "s3") {
            return await uploadToS3(temporaryBackupPath, normalizedConfig, fileName);
        }

        return await uploadToGoogleDrive(temporaryBackupPath, normalizedConfig, fileName);
    } finally {
        await fsAsync.rm(temporaryBackupPath, { force: true });
        backupInProgress = false;
    }
}

/**
 * Run a scheduled backup when the configured interval has elapsed.
 * @returns {Promise<void>} Resolves after the scheduled check
 */
async function runScheduledBackup() {
    const config = normalizeConfig(await Settings.get(BACKUP_SETTING));
    if (!config.enabled || config.provider === "disabled") {
        return;
    }

    const lastRun = Number(await Settings.get(LAST_RUN_SETTING));
    const intervalMs = Number(config.scheduleHours) * 60 * 60 * 1000;
    if (Number.isFinite(lastRun) && Date.now() - lastRun < intervalMs) {
        return;
    }

    try {
        await createDatabaseBackup(config);
        await Settings.set(LAST_RUN_SETTING, Date.now(), "general");
        log.info("backup", "Scheduled database backup completed");
    } catch (error) {
        log.error("backup", `Scheduled database backup failed: ${error.message}`);
    }
}

module.exports = {
    createDatabaseBackup,
    getDefaultBackupConfig,
    normalizeConfig,
    runScheduledBackup,
    testBackupConnection,
};
