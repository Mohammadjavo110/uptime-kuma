-- You should not modify if this has been pushed to GitHub, unless it fixes a serious database issue.
BEGIN TRANSACTION;

ALTER TABLE monitor
    ADD latency_spike_enabled BOOLEAN default 0 not null;

ALTER TABLE monitor
    ADD latency_spike_threshold INTEGER default 0 not null;

COMMIT;
