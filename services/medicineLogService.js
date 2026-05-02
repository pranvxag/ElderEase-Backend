const admin = require('firebase-admin');
const twilio = require('twilio');

const twilioClient = process.env.TWILIO_ACCOUNT_SID
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

function getTodayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatReminderTime(date = new Date()) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

async function getUserProfile(uid) {
    if (!admin.apps.length) {
        return null;
    }

    const db = admin.firestore();
    const fallbackProfileRef = db.collection('users').doc(uid).collection('profile').doc('data');
    const directProfileRef = db.doc(`users/${uid}/profile`);

    const directSnap = await directProfileRef.get();
    if (directSnap.exists) {
        return directSnap.data();
    }

    const fallbackSnap = await fallbackProfileRef.get();
    if (fallbackSnap.exists) {
        return fallbackSnap.data();
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
            updatedAt: new Date().toISOString(),
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

    const timeStr = new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
    });

    const message = status === 'taken'
        ? `ElderEase: ${userName} has taken their ${medicineName} at ${timeStr}. ✅`
        : `ElderEase: ${userName} has NOT taken their ${medicineName} scheduled at ${timeStr}. Please check on them. ⚠️`;

    await twilioClient.messages.create({
        to: caregiver.phone,
        from: process.env.TWILIO_PHONE_NUMBER,
        body: message,
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
        nextReminderAt: futureDate.toISOString(),
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