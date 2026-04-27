require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { startCallerService, scheduleCallback } = require('./services/callerService');
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

app.get('/ping', (req, res) => {
    res.send('pong');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.post('/call/start', (req, res) => {
    const medicineName = req.query.medicineName || 'your medicine';
    const uid = req.query.uid;
    
    const twiml = `
        <Response>
            <Gather input="speech" action="/call/response?medicineName=${encodeURIComponent(medicineName)}&amp;uid=${encodeURIComponent(uid)}" timeout="5">
                <Say>Hello! This is ElderEase reminding you to take your ${medicineName}. Have you taken it?</Say>
            </Gather>
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

app.post('/call/sugar-check', (req, res) => {
    const twiml = `
        <Response>
            <Gather input="speech" action="/call/sugar-response" timeout="5">
                <Say>Hello! This is ElderEase reminding you to check your blood sugar. What is your reading?</Say>
            </Gather>
        </Response>
    `;
    res.type('text/xml');
    res.send(twiml);
});

app.post('/call/workout', (req, res) => {
    const twiml = `
        <Response>
            <Gather input="speech" action="/call/workout-response" timeout="5">
                <Say>Hello from ElderEase! You just finished your workout. How are you feeling?</Say>
            </Gather>
        </Response>
    `;
    res.type('text/xml');
    res.send(twiml);
});

// Mock endpoints for the ones required above
app.post('/call/sugar-response', (req, res) => {
    res.type('text/xml');
    res.send('<Response><Say>Noted. Have a good day!</Say></Response>');
});

app.post('/call/workout-response', (req, res) => {
    res.type('text/xml');
    res.send('<Response><Say>Great! Keep it up. Goodbye.</Say></Response>');
});

startCallerService();

app.listen(PORT, () => {
    console.log(`ElderEase Server running on port ${PORT}`);
});
