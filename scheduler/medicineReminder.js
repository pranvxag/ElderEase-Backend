const cron = require('node-cron');
const admin = require('firebase-admin');
const { triggerMedicineReminderCall } = require('../calls/medicineReminderCall');
const { updateMedicineEntryStatus, formatReminderTime } = require('../services/medicineLogService');

function getCurrentTimeKey(date = new Date()) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function getPreviousTimeKey(date = new Date()) {
    const previous = new Date(date.getTime() - 60 * 1000);
    return getCurrentTimeKey(previous);
}

function shouldTriggerPendingEntry(entry, currentTime, previousTime) {
    return entry.status === 'pending' && (entry.reminderTime === currentTime || entry.reminderTime === previousTime);
}

function shouldTriggerSnoozedEntry(entry, now) {
    if (entry.status !== 'snoozed' || !entry.nextReminderAt) {
        return false;
    }

    const nextReminderAt = new Date(entry.nextReminderAt);
    if (Number.isNaN(nextReminderAt.getTime())) {
        return false;
    }

    if (now < nextReminderAt) {
        return false;
    }

    if (entry.lastTriggeredAt) {
        const lastTriggeredAt = new Date(entry.lastTriggeredAt);
        if (!Number.isNaN(lastTriggeredAt.getTime()) && lastTriggeredAt >= nextReminderAt) {
            return false;
        }
    }

    return true;
}

async function checkAndTriggerReminders() {
    const now = new Date();
    const currentTime = getCurrentTimeKey(now);
    const previousTime = getPreviousTimeKey(now);
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    if (!admin.apps.length) {
        console.warn('Firebase admin not initialized, skipping medicine reminder check');
        return;
    }

    const db = admin.firestore();
    const usersSnap = await db.collection('users').get();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    for (const userDoc of usersSnap.docs) {
        const uid = userDoc.id;
        const currentLogSnap = await db.doc(`users/${uid}/medicinelogs/${today}`).get();
        const previousLogSnap = yesterdayKey === today ? null : await db.doc(`users/${uid}/medicinelogs/${yesterdayKey}`).get();

        const logsToScan = [
            { logDate: today, entries: currentLogSnap.data()?.entries ?? [] },
            ...(previousLogSnap ? [{ logDate: yesterdayKey, entries: previousLogSnap.data()?.entries ?? [] }] : []),
        ];

        for (const log of logsToScan) {
            for (const entry of log.entries) {
                try {
                    const shouldTrigger = shouldTriggerPendingEntry(entry, currentTime, previousTime) || shouldTriggerSnoozedEntry(entry, now);

                    if (!shouldTrigger) {
                        continue;
                    }

                    await updateMedicineEntryStatus(uid, entry.id, entry.status, {
                        logDate: log.logDate,
                        lastTriggeredAt: now.toISOString(),
                        reminderTime: entry.reminderTime || formatReminderTime(now),
                    });

                    await triggerMedicineReminderCall(uid, {
                        ...entry,
                        logDate: log.logDate,
                    });
                } catch (error) {
                    console.error('Error triggering medicine reminder for entry:', { uid, entryId: entry.id, error: error.message });
                }
            }
        }
    }
}

let scheduled = false;

function start() {
    if (scheduled) {
        return;
    }

    scheduled = true;
    cron.schedule('* * * * *', () => {
        checkAndTriggerReminders().catch((error) => {
            console.error('Medicine reminder scheduler failed:', error);
        });
    });

    console.log('Medicine reminder scheduler started...');
}

module.exports = {
    start,
    checkAndTriggerReminders,
};