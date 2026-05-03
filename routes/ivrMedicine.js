const express = require('express');
const twilio = require('twilio');
const {
    updateMedicineEntryStatus,
    sendCaregiverSMS,
    scheduleSnoozedCall,
} = require('../services/medicineLogService');

const router = express.Router();

const MESSAGES = {
    prompt: {
        en: (name) => `Hello! This is ElderEase. It is time to take your ${name}. Press 1 if you have already taken it. Press 2 if you have not.`,
        hi: (name) => `नमस्ते! यह ElderEase है। ${name} लेने का समय हो गया है। अगर आपने ले लिया तो 1 दबाएं। नहीं लिया तो 2 दबाएं।`,
        mr: (name) => `नमस्कार! हे ElderEase आहे। ${name} घेण्याची वेळ झाली आहे। घेतली असेल तर 1 दाबा। नाही घेतली तर 2 दाबा।`,
    },
    noResponse: {
        en: () => 'We did not receive your response. We will call you again in 15 minutes.',
        hi: () => 'हमें आपका जवाब नहीं मिला। हम 15 मिनट में फिर से कॉल करेंगे।',
        mr: () => 'आम्हाला तुमचे उत्तर मिळाले नाही. आम्ही 15 मिनिटांनी पुन्हा कॉल करू.',
    },
    taken: {
        en: (name) => `Great! I have recorded that you have taken your ${name}. Have a healthy day!`,
        hi: (name) => `बहुत अच्छा! मैंने दर्ज कर लिया है कि आपने ${name} ले लिया। स्वस्थ रहें!`,
        mr: (name) => `छान! मी नोंद केली आहे की तुम्ही ${name} घेतली. निरोगी राहा!`,
    },
    snoozed: {
        en: (name) => `No problem. Please take your ${name} soon. I will call you again in 15 minutes.`,
        hi: (name) => `कोई बात नहीं। कृपया जल्द ${name} लें। मैं 15 मिनट में फिर से कॉल करूंगा।`,
        mr: (name) => `ठीक आहे. कृपया लवकरच ${name} घ्या. मी 15 मिनिटांनी पुन्हा कॉल करेन.`,
    },
    invalid: {
        en: () => 'Invalid input. We will call you again in 15 minutes.',
        hi: () => 'गलत इनपुट। हम 15 मिनट में फिर से कॉल करेंगे।',
        mr: () => 'चुकीचे उत्तर. आम्ही 15 मिनिटांनी पुन्हा कॉल करू.',
    },
};

const VOICE_LANG_MAP = {
    en: 'en-IN',
    hi: 'hi-IN',
    mr: 'mr-IN',
};

const VOICE_NAME_MAP = {
    en: 'alice',
    hi: 'Polly.Aditi',
    mr: 'Polly.Aditi',
};

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

function buildPromptTwiml(uid, entryId, medicineName, logDate, lang = 'en') {
    const twiml = new twilio.twiml.VoiceResponse();
    const normalizedLang = normalizeLang(lang);
    const voiceLang = VOICE_LANG_MAP[normalizedLang] ?? 'en-IN';
    const voiceName = VOICE_NAME_MAP[normalizedLang] ?? 'alice';

    const gather = twiml.gather({
        numDigits: 1,
        action: `/ivr/medicine-response?uid=${encodeURIComponent(uid)}&entryId=${encodeURIComponent(entryId)}&medicineName=${encodeURIComponent(medicineName)}&logDate=${encodeURIComponent(logDate ?? '')}&lang=${normalizedLang}`,
        method: 'POST',
        timeout: 10,
        actionOnEmptyResult: true,
    });

    gather.say({ voice: voiceName, language: voiceLang }, MESSAGES.prompt[normalizedLang](medicineName));
    twiml.say({ voice: voiceName, language: voiceLang }, MESSAGES.noResponse[normalizedLang]());

    return twiml;
}

async function handleMedicineReminder(req, res) {
    const uid = req.query.uid || req.body.uid;
    const entryId = req.query.entryId || req.body.entryId;
    const medicineName = req.query.medicineName || req.body.medicineName || 'your medicine';
    const logDate = req.query.logDate || req.body.logDate;
    const lang = normalizeLang(req.query.lang || req.body.lang || 'en');

    console.log(`[Medicine Reminder] 🌐 IVR /medicine-reminder hit → uid=${uid} medicine=${medicineName} lang=${lang}`);

    const twiml = buildPromptTwiml(uid, entryId, medicineName, logDate, lang);
    res.type('text/xml').send(twiml.toString());
}

async function handleMedicineResponse(req, res) {
    const uid = req.query.uid || req.body.uid;
    const entryId = req.query.entryId || req.body.entryId;
    const medicineName = req.query.medicineName || req.body.medicineName || 'your medicine';
    const logDate = req.query.logDate || req.body.logDate;
    const lang = normalizeLang(req.query.lang || req.body.lang || 'en');
    const voiceLang = VOICE_LANG_MAP[lang] ?? 'en-IN';
    const voiceName = VOICE_NAME_MAP[lang] ?? 'alice';
    const digit = req.body.Digits;

    console.log(`[Medicine Reminder] 🔢 IVR /medicine-response hit → uid=${uid} digit=${digit ?? 'none'} medicine=${medicineName} lang=${lang}`);

    const twiml = new twilio.twiml.VoiceResponse();

    if (digit === '1') {
        await updateMedicineEntryStatus(uid, entryId, 'taken', { logDate });
        await sendCaregiverSMS(uid, medicineName, 'taken');
        twiml.say({ voice: voiceName, language: voiceLang }, MESSAGES.taken[lang](medicineName));
        console.log(`[Medicine Reminder] ✅ User ${uid} TOOK ${medicineName}`);
    } else if (digit === '2') {
        await scheduleSnoozedCall(uid, entryId, medicineName, 15, { logDate, lang });
        twiml.say({ voice: voiceName, language: voiceLang }, MESSAGES.snoozed[lang](medicineName));
        console.log(`[Medicine Reminder] 😴 User ${uid} SNOOZED ${medicineName} — will retry in 15 min`);
    } else {
        await scheduleSnoozedCall(uid, entryId, medicineName, 15, { logDate, lang });
        twiml.say({ voice: voiceName, language: voiceLang }, MESSAGES.invalid[lang]());
        console.log(`[Medicine Reminder] ❓ User ${uid} gave no/invalid input for ${medicineName} — will retry in 15 min`);
    }

    res.type('text/xml').send(twiml.toString());
}

async function handleCallStatus(req, res) {
    const uid = req.query.uid || req.body.uid;
    const entryId = req.query.entryId || req.body.entryId;
    const medicineName = req.query.medicineName || req.body.medicineName || 'your medicine';
    const logDate = req.query.logDate || req.body.logDate;
    const lang = normalizeLang(req.query.lang || req.body.lang || 'en');
    const callStatus = req.body.CallStatus;

    console.log(`[Medicine Reminder] 📊 IVR /call-status hit → uid=${uid} status=${callStatus} medicine=${medicineName}`);

    if (['no-answer', 'busy', 'failed', 'canceled'].includes(callStatus)) {
        console.log(`[Medicine Reminder] ⚠️ Call ${callStatus} for ${uid} — scheduling retry in 15 min`);
        await scheduleSnoozedCall(uid, entryId, medicineName, 15, { logDate, lang });
    }

    res.status(200).send('ok');
}

router.route('/ivr/medicine-reminder').get(handleMedicineReminder).post(handleMedicineReminder);
router.post('/ivr/medicine-response', handleMedicineResponse);
router.post('/ivr/call-status', handleCallStatus);

module.exports = router;