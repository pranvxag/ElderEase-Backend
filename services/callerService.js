const cron = require('node-cron');
const twilio = require('twilio');
const admin = require('firebase-admin');

// Ensure to handle the possibility of credentials not being set initially 
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
        const serviceAccount = require(`../${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (err) {
        console.error('Failed to initialize Firebase:', err);
    }
}

const twilioClient = process.env.TWILIO_ACCOUNT_SID ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

function makeCall(phoneNumber, medicineName, uid) {
    if (!twilioClient) {
        console.warn('Twilio not configured, skipping call.');
        return;
    }
    
    const url = `${process.env.SERVER_URL || 'http://localhost:3000'}/call/start?medicineName=${encodeURIComponent(medicineName)}&uid=${encodeURIComponent(uid)}`;

    twilioClient.calls.create({
        url: url,
        to: phoneNumber,
        from: process.env.TWILIO_PHONE_NUMBER
    }).then(call => {
        console.log(`Call initiated to ${phoneNumber}, callSid: ${call.sid}`);
        
        // After 30 sec check callSid status
        setTimeout(async () => {
             try {
                 const fetchedCall = await twilioClient.calls(call.sid).fetch();
                 const status = fetchedCall.status;
                 console.log(`Call status after 30s: ${status}`);
                 
                 if (['no-answer', 'busy', 'failed'].includes(status)) {
                     await twilioClient.messages.create({
                         body: `ElderEase Reminder: Time to take ${medicineName}.`,
                         from: process.env.TWILIO_PHONE_NUMBER,
                         to: phoneNumber
                     });
                     console.log(`Sent SMS reminder for ${medicineName} to ${phoneNumber}.`);
                 }
             } catch (err) {
                 console.error(`Error checking call status for ${call.sid}:`, err);
             }
        }, 30 * 1000);
        
    }).catch(err => {
        console.error(`Error initiating call to ${phoneNumber}:`, err);
    });
}

function scheduleCallback(uid, medicineName, minutes) {
    setTimeout(async () => {
        try {
            if (!admin.apps.length) return;
            const db = admin.firestore();
            const userDoc = await db.collection('users').doc(uid).collection('profile').doc('data').get();
            
            if (userDoc.exists) {
                const phoneNumber = userDoc.data().phoneNumber;
                if (phoneNumber) {
                    console.log(`Scheduling callback for ${uid} in ${minutes} mins...`);
                    makeCall(phoneNumber, medicineName, uid);
                }
            }
        } catch (error) {
            console.error(`Error in scheduled callback for ${uid}:`, error);
        }
    }, minutes * 60 * 1000);
}

function startCallerService() {
    console.log('Caller Service started...');
    // node-cron every minute
    cron.schedule('* * * * *', async () => {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const currentTime = `${hours}:${minutes}`;
        
        console.log(`Cron triggered at ${currentTime}, checking medicines...`);
        
        try {
            if (!admin.apps.length) {
                console.warn('Firebase admin not initialized, skipping cron task');
                return;
            }
            
            const db = admin.firestore();
            const usersSnapshot = await db.collection('users').get();
            
            for (const userDoc of usersSnapshot.docs) {
                const uid = userDoc.id;
                const profileDataDoc = await db.collection('users').doc(uid).collection('profile').doc('data').get();
                
                if (profileDataDoc.exists) {
                    const userData = profileDataDoc.data();
                    const phoneNumber = userData.phoneNumber;
                    const medicines = userData.medicines || []; // expected: [{ name: "Aspirin", times: ["08:00", "20:00"] }]
                    
                    if (phoneNumber && Array.isArray(medicines)) {
                        medicines.forEach(medicine => {
                            if (Array.isArray(medicine.times) && medicine.times.includes(currentTime)) {
                                console.log(`Match found! Calling ${phoneNumber} for ${medicine.name || 'your medicine'}`);
                                makeCall(phoneNumber, medicine.name || 'your medicine', uid);
                            }
                        });
                    }
                }
            }
            
        } catch (err) {
            console.error('Error reading Firestore users:', err);
        }
    });
}

module.exports = { startCallerService, makeCall, scheduleCallback };
