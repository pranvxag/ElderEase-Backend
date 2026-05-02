const cron = require('node-cron');
const admin = require('firebase-admin');
const { triggerMedicineReminderCall } = require('../calls/medicineReminderCall');
const { updateMedicineEntryStatus, formatReminderTime } = require('../services/medicineLogService');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

function toIST(date = new Date()) {
    return new Date(date.getTime() + IST_OFFSET_MS);
}

function getCurrentTimeKey(date = new Date()) {
    const ist = toIST(date);
    return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
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
    const ist = toIST(now);
    const today = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;

    console.log(`[Medicine Reminder] ⏰ Cron tick at ${now.toISOString()} | checking ${currentTime} / ${previousTime}`);

    if (!admin.apps.length) {
        console.warn('[Medicine Reminder] ⚠️ Firebase admin not initialized, skipping');
        return;
    }

    const db = admin.firestore();
    const userRefs = await db.collection('users').listDocuments();
    const yesterdayIST = new Date(ist.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayKey = `${yesterdayIST.getUTCFullYear()}-${String(yesterdayIST.getUTCMonth() + 1).padStart(2, '0')}-${String(yesterdayIST.getUTCDate()).padStart(2, '0')}`;

    console.log(`[Medicine Reminder] 👥 Found ${userRefs.length} users to scan`);

    let triggeredCount = 0;

    for (const userRef of userRefs) {
        const uid = userRef.id;
        const currentLogSnap = await db.doc(`users/${uid}/medicinelogs/${today}`).get();
        const previousLogSnap = yesterdayKey === today ? null : await db.doc(`users/${uid}/medicinelogs/${yesterdayKey}`).get();

        const logsToScan = [
            { logDate: today, entries: currentLogSnap.data()?.entries ?? [] },
            ...(previousLogSnap ? [{ logDate: yesterdayKey, entries: previousLogSnap.data()?.entries ?? [] }] : []),
        ];

        const totalEntries = logsToScan.reduce((sum, l) => sum + l.entries.length, 0);
        if (totalEntries > 0) {
            console.log(`[Medicine Reminder] 📋 User ${uid}: ${totalEntries} entries to check`);
        }

        for (const log of logsToScan) {
            for (const entry of log.entries) {
                try {
                    const isPending = shouldTriggerPendingEntry(entry, currentTime, previousTime);
                    const isSnoozed = shouldTriggerSnoozedEntry(entry, now);
                    const shouldTrigger = isPending || isSnoozed;

                    if (!shouldTrigger) {
                        continue;
                    }

                    console.log(`[Medicine Reminder] 🔔 Triggering ${isPending ? 'PENDING' : 'SNOOZED'} reminder → uid=${uid} medicine=${entry.medicineName} time=${entry.reminderTime} lang=${entry.lang || 'auto'}`);

                    await updateMedicineEntryStatus(uid, entry.id, entry.status, {
                        logDate: log.logDate,
                        lastTriggeredAt: now.toISOString(),
                        reminderTime: entry.reminderTime || formatReminderTime(now),
                    });

                    await triggerMedicineReminderCall(uid, {
                        ...entry,
                        logDate: log.logDate,
                    });

                    triggeredCount++;
                } catch (error) {
                    console.error(`[Medicine Reminder] ❌ Error for uid=${uid} entryId=${entry.id}:`, error.message);
                }
            }
        }
    }

    if (triggeredCount > 0) {
        console.log(`[Medicine Reminder] ✅ Cron tick done — ${triggeredCount} reminder(s) triggered`);
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

    // Heartbeat every 5 minutes so we can confirm it's alive on Render
    setInterval(() => {
        console.log('[Medicine Reminder] Scheduler heartbeat - still active ✅');
    }, 5 * 60 * 1000);

    console.log('[Medicine Reminder] Scheduler started ✅');
}

module.exports = {
    start,
    checkAndTriggerReminders,
};