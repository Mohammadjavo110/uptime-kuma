\# Uptime Kuma Architectural Rules



\- \*\*Strict Protocol:\*\* Never use REST API endpoints. Client-Server communication is 100% via Socket.io events.

\- \*\*SQLite WAL Safety:\*\* Never copy `kuma.db` directly. Use `VACUUM INTO 'temp\_backup.db'` before uploading/copying database files.

\- \*\*Migrations:\*\* All schema alterations must be added as patches inside `server/database.js`.

\- \*\*UI Strings:\*\* All UI labels must be registered in `src/languages/en.json`.

\- \*\*Feature 1 (Latency Spike):\*\* Calculate average response time of the last 15 beats in memory. Send warning without changing monitor UP status to DOWN.

\- \*\*Feature 2 (Cloud Backup):\*\* Background job in `server/jobs/backup.js` for S3 \& GDrive with temporary VACUUM snapshot.

