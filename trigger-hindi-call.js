require('dotenv').config();
const admin = require('firebase-admin');
const { makeCall } = require('./services/callerService');

if (!admin.apps.length) {
    const serviceAccount = require('./' + process.env.GOOGLE_APPLICATION_CREDENTIALS);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function run() {
    const uid = 'test_hindi_user_123';
    const profileData = {
        displayName: 'Hindi Test User',
        phoneNumber: '+918010561437',
        preferredLanguage: 'hi',
        medicines: [
            {
                name: 'Vitamins',
                times: ['10:00'] // Time doesn't matter for manual trigger
            }
        ],
        emergencyContacts: [
            {
                name: 'Caregiver',
                phone: '+918010561437'
            }
        ]
    };

    try {
        await db.collection('users').doc(uid).collection('profile').doc('data').set(profileData);
        console.log(`Successfully created Hindi test user (UID: ${uid}).`);
        
        console.log("Triggering makeCall directly for Hindi...");
        await makeCall('+918010561437', 'Vitamins', uid);
        console.log("makeCall execution finished. Waiting for Twilio request to complete...");
    } catch (error) {
        console.error('Error:', error);
    } finally {
        setTimeout(() => {
            console.log("Done.");
            process.exit(0);
        }, 5000);
    }
}

run();
