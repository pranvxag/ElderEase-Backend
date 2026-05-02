require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccount = require('./firebase-admin-key.json');
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

const express = require('express');
const fetch = require('node-fetch');
const { startCallerService, scheduleCallback, sendCaregiverSMS, generateWeeklyReport } = require('./services/callerService');
const { startEmergencyListener } = require('./services/emergencyListener');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Self ping every 14 mins to https://eldereaseapp.onrender.com/ping
setInterval(() => {
    fetch('https://eldereaseapp.onrender.com/ping')
        .then(res => res.text())
        .then(text => console.log('Pinged self:', text))
        .catch(err => console.error('Ping failed:', err));
}, 14 * 60 * 1000);

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

function getCallContent(lang, type, medicineName = '') {
    let voice = 'Polly.Joanna';
    let language = 'en-US';

    if (lang === 'hi' || lang === 'mr') {
        voice = 'Polly.Aditi';
        language = 'hi-IN';
    }

    const messages = {
        medicine: {
            en: `Hello! This is ElderEase. It is time for your ${medicineName}. Press 1 if you have taken it. Press 2 if you have not.`,
            hi: `नमस्ते! यह ElderEase है। ${medicineName} लेने का समय हो गया है। अगर आपने ले लिया तो 1 दबाएं। नहीं लिया तो 2 दबाएं।`,
            mr: `नमस्कार! हे ElderEase आहे। ${medicineName} घेण्याची वेळ झाली आहे। घेतली असेल तर 1 दाबा। नाही घेतली तर 2 दाबा।`
        },
        sugar: {
            en: `Hello! Have you checked your blood sugar today?`,
            hi: `नमस्ते! क्या आपने आज अपना ब्लड शुगर चेक किया?`,
            mr: `नमस्कार! तुम्ही आज रक्तातील साखर तपासली का?`
        },
        workout: {
            en: `Hello! How are you feeling after your workout today?`,
            hi: `नमस्ते! आज व्यायाम के बाद आप कैसा महसूस कर रहे हैं?`,
            mr: `नमस्कार! आज व्यायामानंतर तुम्हाला कसे वाटत आहे?`
        },
        taken: {
            en: `Thank you for taking your medicine. Stay healthy!`,
            hi: `दवाई लेने के लिए धन्यवाद। स्वस्थ रहें!`,
            mr: `औषध घेतल्याबद्दल धन्यवाद। निरोगी राहा!`
        },
        not_taken: {
            en: `Please take your medicine soon. I will check on you in 15 minutes.`,
            hi: `कृपया जल्द दवाई लें। मैं 15 मिनट में फिर कॉल करूंगा।`,
            mr: `कृपया लवकर औषध घ्या। मी 15 मिनिटांत पुन्हा कॉल करेन।`
        },
        no_input: {
            en: `I did not get a response. Your caregiver will be notified.`,
            hi: `मुझे कोई जवाब नहीं मिला। आपके केयरगिवर को सूचित किया जाएगा।`,
            mr: `मला काही उत्तर मिळाले नाही। तुमच्या काळजीवाहकाला कळवले जाईल।`
        },
        sugar_morning: {
            en: `Hello! This is ElderEase. Please enter your fasting blood sugar level using the keypad, followed by the hash key.`,
            hi: `नमस्ते! यह ElderEase है। कृपया कीपैड का उपयोग करके अपना खाली पेट का ब्लड शुगर लेवल दर्ज करें, और फिर हैश कुंजी दबाएं।`,
            mr: `नमस्कार! हे ElderEase आहे। कृपया कीपॅड वापरून तुमची उपाशीपोटी रक्तातील साखरेची पातळी प्रविष्ट करा आणि नंतर हॅश की दाबा।`
        },
        sugar_evening: {
            en: `Hello! This is ElderEase. Please enter your after-lunch blood sugar level using the keypad, followed by the hash key.`,
            hi: `नमस्ते! यह ElderEase है। कृपया कीपैड का उपयोग करके अपने दोपहर के भोजन के बाद का ब्लड शुगर लेवल दर्ज करें, और फिर हैश कुंजी दबाएं।`,
            mr: `नमस्कार! हे ElderEase आहे। कृपया कीपॅड वापरून तुमच्या दुपारच्या जेवणानंतरची रक्तातील साखरेची पातळी प्रविष्ट करा आणि नंतर हॅश की दाबा।`
        },
        sugar_saved: {
            en: `Thank you. Your blood sugar level has been saved.`,
            hi: `धन्यवाद। आपका ब्लड शुगर लेवल सेव कर लिया गया है।`,
            mr: `धन्यवाद। तुमची रक्तातील साखरेची पातळी सेव्ह केली आहे।`
        }
    };

    const message = messages[type]?.[lang] || messages[type]?.['en'] || '';

    return { message, voice, language };
}

app.get('/ping', (req, res) => {
    res.send('pong');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.post('/call/start', (req, res) => {
    const medicineName = req.query.medicineName || 'your medicine';
    const uid = req.query.uid;
    const lang = req.query.lang || 'en';

    const callContent = getCallContent(lang, 'medicine', medicineName);

    const twiml = `
        <Response>
            <Gather input="dtmf" action="/call/ivr-response?medicineName=${encodeURIComponent(medicineName)}&amp;uid=${encodeURIComponent(uid)}&amp;lang=${lang}" numDigits="1" timeout="5">
                <Say voice="${callContent.voice}" language="${callContent.language}">${callContent.message}</Say>
            </Gather>
            <Redirect>/call/ivr-response?medicineName=${encodeURIComponent(medicineName)}&amp;uid=${encodeURIComponent(uid)}&amp;lang=${lang}</Redirect>
        </Response>
    `;
    res.type('text/xml');
    res.send(twiml);
});

app.post('/call/response', async (req, res) => {
    const { SpeechResult } = req.body;
    const medicineName = req.query.medicineName;
    const uid = req.query.uid;

    let twimlResponse = '<Response><Say>I did not catch that. Please try again later.</Say></Response>';

    if (SpeechResult) {
        try {
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `You are a helpful assistant for an elder. They are asked if they have taken their medicine (${medicineName}). Reply in 1 short sentence.`
                    },
                    {
                        role: "user",
                        content: SpeechResult
                    }
                ],
                model: "llama-3.3-70b-versatile",
            });

            const reply = chatCompletion.choices[0]?.message?.content || 'Thank you.';
            const lowerSpeech = SpeechResult.toLowerCase();

            if (lowerSpeech.includes('later') || lowerSpeech.includes('15') || lowerSpeech.includes('wait')) {
                scheduleCallback(uid, medicineName, 15);
                twimlResponse = `<Response><Say>${reply} I will call you back in 15 minutes.</Say></Response>`;
            } else {
                twimlResponse = `<Response><Say>${reply}</Say></Response>`;
            }
        } catch (error) {
            console.error('Groq error:', error);
            twimlResponse = '<Response><Say>Sorry, I encountered an issue.</Say></Response>';
        }
    }

    res.type('text/xml');
    res.send(twimlResponse);
});

app.post('/call/ivr-response', async (req, res) => {
    const { Digits } = req.body;
    const medicineName = req.query.medicineName || 'your medicine';
    const uid = req.query.uid;
    const lang = req.query.lang || 'en';

    let callContent;

    if (Digits === '1') {
        callContent = getCallContent(lang, 'taken', medicineName);
        await sendCaregiverSMS(uid, medicineName, 'taken');
    } else if (Digits === '2') {
        scheduleCallback(uid, medicineName, 15);
        callContent = getCallContent(lang, 'not_taken', medicineName);
        await sendCaregiverSMS(uid, medicineName, 'not taken');
    } else {
        // No input
        callContent = getCallContent(lang, 'no_input', medicineName);
        await sendCaregiverSMS(uid, medicineName, 'no response');
    }

    const twimlResponse = `<Response><Say voice="${callContent.voice}" language="${callContent.language}">${callContent.message}</Say></Response>`;

    res.type('text/xml');
    res.send(twimlResponse);
});

app.post('/call/start-sugar', (req, res) => {
    const timeType = req.query.timeType || 'morning';
    const uid = req.query.uid;
    const lang = req.query.lang || 'en';

    const callContent = getCallContent(lang, `sugar_${timeType}`);

    const twiml = `
        <Response>
            <Gather input="dtmf" action="/call/sugar-ivr-response?timeType=${encodeURIComponent(timeType)}&amp;uid=${encodeURIComponent(uid)}&amp;lang=${lang}" finishOnKey="#" timeout="10">
                <Say voice="${callContent.voice}" language="${callContent.language}">${callContent.message}</Say>
            </Gather>
            <Redirect>/call/start-sugar?timeType=${encodeURIComponent(timeType)}&amp;uid=${encodeURIComponent(uid)}&amp;lang=${lang}</Redirect>
        </Response>
    `;
    res.type('text/xml');
    res.send(twiml);
});

app.post('/call/sugar-ivr-response', async (req, res) => {
    const { Digits } = req.body;
    const timeType = req.query.timeType || 'morning';
    const uid = req.query.uid;
    const lang = req.query.lang || 'en';

    if (Digits) {
        try {
            const admin = require('firebase-admin');
            if (admin.apps.length && uid) {
                const db = admin.firestore();
                const today = new Date().toISOString().split('T')[0];
                const sugarRef = db.collection('users').doc(uid).collection('sugarlogs').doc(today);

                await db.runTransaction(async (t) => {
                    const doc = await t.get(sugarRef);
                    if (!doc.exists) {
                        t.set(sugarRef, {
                            [timeType]: Digits,
                            readings: [{ type: timeType, value: Digits, timestamp: admin.firestore.FieldValue.serverTimestamp() }]
                        });
                    } else {
                        const data = doc.data();
                        const readings = data.readings || [];
                        readings.push({ type: timeType, value: Digits, timestamp: admin.firestore.FieldValue.serverTimestamp() });
                        t.update(sugarRef, {
                            [timeType]: Digits,
                            readings: readings
                        });
                    }
                });
                console.log(`Saved sugar level ${Digits} for ${uid} at ${timeType}`);
            }
        } catch (err) {
            console.error('Error saving sugar level:', err);
        }

        const callContent = getCallContent(lang, 'sugar_saved');
        const twimlResponse = `<Response><Say voice="${callContent.voice}" language="${callContent.language}">${callContent.message}</Say></Response>`;
        res.type('text/xml');
        res.send(twimlResponse);
    } else {
        const twimlResponse = `<Response><Say>No input received. Goodbye.</Say></Response>`;
        res.type('text/xml');
        res.send(twimlResponse);
    }
});

app.post('/call/workout', (req, res) => {
    const lang = req.query.lang || 'en';
    const callContent = getCallContent(lang, 'workout');

    const twiml = `
        <Response>
            <Gather input="speech" action="/call/workout-response?lang=${lang}" timeout="5">
                <Say voice="${callContent.voice}" language="${callContent.language}">${callContent.message}</Say>
            </Gather>
        </Response>
    `;
    res.type('text/xml');
    res.send(twiml);
});

// Note: Sugar response is now handled by /call/sugar-ivr-response

app.post('/call/workout-response', (req, res) => {
    res.type('text/xml');
    res.send('<Response><Say>Great! Keep it up. Goodbye.</Say></Response>');
});

app.get('/report/:uid', async (req, res) => {
    const uid = req.params.uid;
    try {
        const reportText = await generateWeeklyReport(uid);
        if (reportText) {
            res.json({ success: true, report: reportText });
        } else {
            res.status(404).json({ success: false, error: 'User not found or report could not be generated' });
        }
    } catch (err) {
        console.error('Error in /report/:uid route:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

startCallerService();
startEmergencyListener();

app.listen(PORT, () => {
    console.log(`ElderEase Server running on port ${PORT}`);
});
