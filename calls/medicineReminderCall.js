const twilio = require('twilio');
const { getUserProfile } = require('../services/medicineLogService');

const twilioClient = process.env.TWILIO_ACCOUNT_SID
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

function normalizeLang(input) {
    const value = String(input || '').trim().toLowerCase();

    if (value === 'hi' || value === 'hindi' || value === 'hindhi') {
        return 'hi';
    }

    if (value === 'mr' || value === 'marathi') {
        return 'mr';
    }

    return 'en';
}

async function triggerMedicineReminderCall(uid, entry) {
    if (!twilioClient) {
        console.warn('Twilio not configured, skipping medicine reminder call.');
        return;
    }

    const profile = await getUserProfile(uid);
    const phone = profile?.phoneNumber;
    const userName = profile?.name || profile?.displayName || 'User';
    const language = normalizeLang(profile?.preferredLanguage ?? entry?.lang ?? 'en');

    if (!phone) {
        console.warn(`Missing phone number for user ${uid}, skipping medicine reminder.`);
        return;
    }

    const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;
    const medicineName = entry.medicineName || 'your medicine';
    const logDate = entry.logDate || new Date().toISOString().split('T')[0];

    console.log(`[Medicine Reminder] 📞 Creating Twilio call → phone=${phone} medicine=${medicineName} lang=${language} uid=${uid}`);

    await twilioClient.calls.create({
        to: phone,
        from: process.env.TWILIO_PHONE_NUMBER,
        url: `${process.env.SERVER_URL}/ivr/medicine-reminder?uid=${uid}&entryId=${encodeURIComponent(entry.id)}&medicineName=${encodeURIComponent(entry.medicineName)}&logDate=${encodeURIComponent(entry.logDate ?? '')}&lang=${language}`,
        statusCallback: `${serverUrl}/ivr/call-status?uid=${encodeURIComponent(uid)}&entryId=${encodeURIComponent(entry.id)}&medicineName=${encodeURIComponent(medicineName)}&logDate=${encodeURIComponent(logDate)}&lang=${language}`,
        statusCallbackMethod: 'POST',
    });

    console.log(`[Medicine Reminder] ✅ Twilio call created for ${userName} (${phone}) — ${medicineName} [${language}]`);
}

module.exports = { triggerMedicineReminderCall };