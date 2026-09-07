<template>
    <div>
        <form class="my-4" autocomplete="off" @submit.prevent="save">
            <div class="mb-4">
                <h2>{{ $t("Database Backup") }}</h2>
                <div class="form-text">
                    {{ $t("backupCloudDescription") }}
                </div>
            </div>

            <div class="mb-4">
                <label for="backup-provider" class="form-label">{{ $t("Backup Provider") }}</label>
                <select id="backup-provider" v-model="config.provider" class="form-select">
                    <option value="disabled">{{ $t("Disabled") }}</option>
                    <option value="s3">{{ $t("Amazon S3 or Compatible") }}</option>
                    <option value="google-drive">{{ $t("Google Drive") }}</option>
                </select>
            </div>

            <template v-if="config.provider === 's3'">
                <div class="mb-4">
                    <label for="s3-endpoint" class="form-label">{{ $t("S3 Endpoint") }}</label>
                    <input id="s3-endpoint" v-model.trim="config.s3.endpoint" class="form-control" type="url" />
                    <div class="form-text">{{ $t("s3EndpointDescription") }}</div>
                </div>

                <div class="mb-4">
                    <label for="s3-region" class="form-label">{{ $t("S3 Region") }}</label>
                    <input id="s3-region" v-model.trim="config.s3.region" class="form-control" type="text" required />
                </div>

                <div class="mb-4">
                    <label for="s3-access-key" class="form-label">{{ $t("S3 Access Key") }}</label>
                    <HiddenInput id="s3-access-key" v-model="config.s3.accessKeyId" autocomplete="new-password" />
                </div>

                <div class="mb-4">
                    <label for="s3-secret-key" class="form-label">{{ $t("S3 Secret Key") }}</label>
                    <HiddenInput id="s3-secret-key" v-model="config.s3.secretAccessKey" autocomplete="new-password" />
                </div>

                <div class="mb-4">
                    <label for="s3-bucket" class="form-label">{{ $t("S3 Bucket Name") }}</label>
                    <input id="s3-bucket" v-model.trim="config.s3.bucket" class="form-control" type="text" required />
                </div>
            </template>

            <template v-if="config.provider === 'google-drive'">
                <div class="mb-4">
                    <label for="google-service-account" class="form-label">
                        {{ $t("Google Service Account JSON") }}
                    </label>
                    <textarea
                        id="google-service-account"
                        v-model.trim="config.googleDrive.serviceAccountJson"
                        class="form-control"
                        rows="8"
                        required
                    ></textarea>
                    <div class="form-text">{{ $t("googleServiceAccountDescription") }}</div>
                </div>

                <div class="mb-4">
                    <label for="google-folder-id" class="form-label">{{ $t("Google Drive Folder ID") }}</label>
                    <input
                        id="google-folder-id"
                        v-model.trim="config.googleDrive.folderId"
                        class="form-control"
                        type="text"
                    />
                    <div class="form-text">{{ $t("googleDriveFolderDescription") }}</div>
                </div>
            </template>

            <div v-if="config.provider !== 'disabled'" class="mb-4">
                <label for="backup-schedule" class="form-label">{{ $t("Backup Interval Hours") }}</label>
                <input
                    id="backup-schedule"
                    v-model.number="config.scheduleHours"
                    class="form-control"
                    type="number"
                    min="1"
                    step="1"
                    required
                />
            </div>

            <div class="mb-4 form-check">
                <input
                    id="backup-enabled"
                    v-model="config.enabled"
                    class="form-check-input"
                    type="checkbox"
                    :disabled="config.provider === 'disabled'"
                />
                <label class="form-check-label" for="backup-enabled">
                    {{ $t("Enable Scheduled Backups") }}
                </label>
            </div>

            <div class="mb-4 d-flex gap-2">
                <button
                    class="btn btn-outline-primary"
                    type="button"
                    :disabled="testing || saving || config.provider === 'disabled'"
                    @click="testConnection"
                >
                    <span v-if="testing" class="spinner-border spinner-border-sm" role="status"></span>
                    {{ $t("Test Connection") }}
                </button>
                <button
                    class="btn btn-outline-success"
                    type="button"
                    :disabled="backingUp || saving || config.provider === 'disabled'"
                    @click="backupNow"
                >
                    <span v-if="backingUp" class="spinner-border spinner-border-sm" role="status"></span>
                    {{ $t("Backup Now") }}
                </button>
            </div>

            <div class="mb-4">
                <button class="btn btn-primary" type="submit" :disabled="saving">
                    <span v-if="saving" class="spinner-border spinner-border-sm" role="status"></span>
                    {{ $t("Save") }}
                </button>
            </div>

            <div class="form-text">
                {{ $t("backupSecurityDescription") }}
            </div>
        </form>
    </div>
</template>

<script>
import HiddenInput from "../../components/HiddenInput.vue";

/**
 * Return the default backup form configuration.
 * @returns {object} Default backup form configuration
 */
function defaultConfig() {
    return {
        enabled: false,
        provider: "disabled",
        scheduleHours: 24,
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

export default {
    components: {
        HiddenInput,
    },

    data() {
        return {
            config: defaultConfig(),
            saving: false,
            testing: false,
            backingUp: false,
        };
    },

    mounted() {
        this.load();
    },

    methods: {
        /**
         * Load backup settings from the server.
         * @returns {void}
         */
        load() {
            this.$root.getSocket().emit("getSettings", (res) => {
                if (!res.ok) {
                    this.$root.toastError(res.msg);
                    return;
                }

                const storedConfig = res.data.backupConfig || {};
                const defaults = defaultConfig();
                this.config = {
                    ...defaults,
                    ...storedConfig,
                    s3: { ...defaults.s3, ...(storedConfig.s3 || {}) },
                    googleDrive: { ...defaults.googleDrive, ...(storedConfig.googleDrive || {}) },
                };
            });
        },

        /**
         * Save backup settings.
         * @returns {void}
         */
        save() {
            this.saving = true;
            this.$root.getSocket().emit("setSettings", { backupConfig: this.config }, null, (res) => {
                this.saving = false;
                this.$root.toastRes(res);
            });
        },

        /**
         * Test the configured backup provider.
         * @returns {void}
         */
        testConnection() {
            this.testing = true;
            this.$root.getSocket().emit("testBackupConnection", this.config, (res) => {
                this.testing = false;
                if (res.ok) {
                    this.$root.toastSuccess(this.$t("Backup Connection Successful"));
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },

        /**
         * Trigger an immediate database backup.
         * @returns {void}
         */
        backupNow() {
            this.backingUp = true;
            this.$root.getSocket().emit("backupDatabaseNow", (res) => {
                this.backingUp = false;
                if (res.ok) {
                    this.$root.toastSuccess(this.$t("Backup Completed"));
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },
    },
};
</script>
