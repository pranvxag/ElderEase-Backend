const admin = require('firebase-admin');
const twilio = require('twilio');
const { getTodayIST, getTimeIST, getISOStringIST, getFormattedTimeIST } = require('../utils/istTime');
const { limitSmsText } = require('../utils/sms');

const twilioClient = process.env.TWILIO_ACCOUNT_SID
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

function getTodayKey(date = new Date()) {
    return getTodayIST(date);
}

function formatReminderTime(date = new Date()) {
    return getTimeIST(date);
}

async function getUserProfile(uid) {
    if (!admin.apps.length) {
        return null;
    }

    const db = admin.firestore();
    const profileRef = db.collection('users').doc(uid).collection('profile').doc('data');

    const snap = await profileRef.get();
    if (snap.exists) {
        return snap.data();
    }

    return null;
}

async function updateMedicineEntryStatus(uid, entryId, status, extraFields = {}) {
    if (!admin.apps.length) {
        return;
    }

    const db = admin.firestore();
    const { logDate = getTodayKey(), ...entryFields } = extraFields;
    const ref = db.doc(`users/${uid}/medicinelogs/${logDate}`);
    const snap = await ref.get();
    const entries = snap.data()?.entries ?? [];

    const updated = entries.map((entry) => {
        if (entry.id !== entryId) {
            return entry;
        }

        return {
            ...entry,
            ...entryFields,
            status,
            updatedAt: getISOStringIST(),
        };
    });

    await ref.set({ entries: updated }, { merge: true });
    console.log('Updated medicine entry status:', { uid, entryId, status });
}

async function sendCaregiverSMS(uid, medicineName, status) {
    if (!admin.apps.length || !twilioClient) {
        return;
    }

    const profile = await getUserProfile(uid);
    if (!profile) {
        return;
    }

    const userName = profile.name || profile.displayName || 'Your patient';
    const contacts = profile.emergencyContacts || [];
    const caregiver = contacts.find((contact) => contact && contact.isPrimary) || contacts[0];

    if (!caregiver || !caregiver.phone) {
        return;
    }

    const timeStr = getFormattedTimeIST();

    const message = status === 'taken'
        ? `💊✅ ${userName} took ${medicineName} at ${timeStr}!`
        : `⚠️ ${userName} MISSED ${medicineName} (${timeStr}). Check soon!`;

    const smsBody = limitSmsText(message);

    await twilioClient.messages.create({
        to: caregiver.phone,
        from: process.env.TWILIO_PHONE_NUMBER,
        body: smsBody,
    });

    console.log('Caregiver SMS sent to:', caregiver.phone);
}

async function scheduleSnoozedCall(uid, entryId, medicineName, delayMinutes, extraFields = {}) {
    const futureDate = new Date(Date.now() + delayMinutes * 60 * 1000);
    const { logDate = getTodayKey(), lang = 'en' } = extraFields;

    await updateMedicineEntryStatus(uid, entryId, 'snoozed', {
        logDate,
        lang,
        reminderTime: formatReminderTime(futureDate),
        nextReminderAt: getISOStringIST(futureDate),
    });

    console.log(`Snoozed call scheduled for ${delayMinutes} min:`, {
        uid,
        entryId,
        medicineName,
    });
}

module.exports = {
    getTodayKey,
    formatReminderTime,
    getUserProfile,
    updateMedicineEntryStatus,
    sendCaregiverSMS,
    scheduleSnoozedCall,
};